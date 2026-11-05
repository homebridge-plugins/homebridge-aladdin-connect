import { Logger } from 'homebridge';
import * as https from 'https';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import axiosRetry from 'axios-retry';
import PubSub from 'pubsub-js';
import Token = PubSubJS.Token;
import AsyncLock from 'async-lock';
import { createHmac } from 'crypto';

interface AwsCognitoInitiateAuthResponse {
  AuthenticationResult: AwsCognitoAuthenticationResult;
  ChallengeParameters: never;
}

interface AwsCognitoAuthenticationResult {
  RefreshToken: string;
  TokenType: 'Bearer';
  ExpiresIn: number;
  IdToken: string;
  AccessToken: string;
}

interface AladdinDevicesEntity {
  devices: AladdinDeviceEntity[];
}

interface AladdinDeviceEntity {
  id: number;
  serial_number: string;
  name: string;
  is_locked: boolean;
  ssid: string;
  user_id: string;
  rssi: number;
  status: number;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
  model: string;
  family: number;
  vendor: string;
  timezone: string;
  zipcode: string;
  is_expired: boolean;
  is_updating_firmware: boolean;
  doors: AladdinDoorEntity[];
  software_version: string;
  ownership: string;
}

interface AladdinDoorEntity {
  id: string;
  battery_level: number;
  created_at: string;
  updated_at: string;
  is_enabled: boolean;
  status: number;
  vehicle_type: string;
  vehicle_color: string;
  link_status: number;
  name: string;
  ble_strength: number;
  door_index: number;
  fault?: number;
}

export interface AladdinDoor {
  deviceId: number;
  id: string;
  index: number;
  serialNumber: string;
  name: string;
  hasBatteryLevel: boolean;
  ownership: string;
  status: AladdinDoorStatus;
  batteryPercent: number | null;
  fault: boolean;
}

export enum AladdinDoorStatus {
  UNKNOWN = 0,
  OPEN = 1,
  OPENING = 2,
  TIMEOUT_OPENING = 3,
  CLOSED = 4,
  CLOSING = 5,
  TIMEOUT_CLOSING = 6,
  NOT_CONFIGURED = 7,
}

export enum AladdinDesiredDoorStatus {
  CLOSED = 0,
  OPEN = 1,
  NONE = 99, // Once the garage is in the desired state Genie reports this.
}

enum AladdinLink {
  // noinspection JSUnusedGlobalSymbols
  UNKNOWN = 0,
  NOT_CONFIGURED = 1,
  PAIRED = 2,
  CONNECTED = 3,
}

export interface AladdinConnectConfig {
  username: string;
  password: string;
  batteryLowLevel?: number;
  doorStatusPollInterval?: number;
  logApiResponses?: boolean;
  logDoorStateChanges?: boolean;
  showShared?: boolean;
}

/**
 * How long a command may take before it is given up on: the client stops fast polling for it and
 * the accessory stops holding the requested target and shows the door's real state again.
 */
export const COMMAND_TIMEOUT_MS = 60 * 1000;

export class AladdinConnect {
  private static readonly PUB_SUB_DOOR_STATUS_TOPIC = 'door';

  private static readonly DOOR_STATUS_POLL_INTERVAL_MS_DEFAULT = 15 * 1000;
  private static readonly DOOR_STATUS_POLL_INTERVAL_MS_MIN = 5 * 1000;
  private static readonly DOOR_STATUS_POLL_INTERVAL_MS_MAX = 60 * 1000;

  // Poll interval while a door is moving or a command has not finished yet.
  private static readonly FAST_POLL_INTERVAL_MS = 3 * 1000;
  // Delay before the first poll after a command, giving Genie a moment to start the door.
  private static readonly COMMAND_FIRST_POLL_DELAY_MS = 1000;
  // Upper bound for the poll interval while Genie is unreachable.
  private static readonly MAX_BACKOFF_MS = 5 * 60 * 1000;
  // Refresh the access token this long before Cognito says it expires.
  private static readonly TOKEN_EXPIRY_MARGIN_S = 60;

  private static readonly API_HOST = 'api.smartgarage.systems';
  private static readonly API_TIMEOUT = 5000;

  private static readonly AUTH_HOST = 'cognito-idp.us-east-2.amazonaws.com';
  private static readonly AUTH_CLIENT_ID = '27iic8c3bvslqngl3hso83t74b';
  private static readonly AUTH_CLIENT_SECRET =
    '7bokto0ep96055k42fnrmuth84k7jdcjablestb7j53o8lp63v5';

  private static readonly DOOR_STATUS_LOCK = 'DOOR_STATUS';
  private static readonly AUTH_LOCK = 'AUTH';

  private readonly lock = new AsyncLock();
  private readonly session: AxiosInstance;

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private refreshToken: string | null = null;
  private cognitoUsername: string | null = null;

  private pollTimer: NodeJS.Timeout | null = null;
  // Commands still under way, by door: the position asked for and when to give up on it.
  private readonly pendingCommands = new Map<
    string,
    { target: AladdinDesiredDoorStatus; deadline: number }
  >();

  private consecutivePollFailures = 0;

  constructor(
    public readonly log: Logger,
    private readonly config: AladdinConnectConfig,
  ) {
    this.session = axios.create({
      httpsAgent: new https.Agent({ keepAlive: true }),
      timeout: AladdinConnect.API_TIMEOUT,
    });
    axiosRetry(this.session, {
      retries: 3,
      // Only retry failures that might succeed on a second attempt: network errors, throttling and
      // server errors. Retrying 4xx responses (e.g. a bad password) only multiplies failed logins
      // and risks locking the account.
      retryCondition: (error) =>
        !error.response || error.response.status === 429 || error.response.status >= 500,
      retryDelay: axiosRetry.exponentialDelay,
      shouldResetTimeout: true,
    });
  }

  subscribe(door: AladdinDoor, func: (info: AladdinDoor) => void): Token {
    const isFirstSubscription =
      PubSub.countSubscriptions(AladdinConnect.PUB_SUB_DOOR_STATUS_TOPIC) === 0;
    const token = PubSub.subscribe(AladdinConnect.doorStatusTopic(door), (_, data) => {
      if (!data) {
        return;
      }
      try {
        func(data);
      } catch (error: unknown) {
        this.log.error(
          '[API] Failed to apply status update for door %s; %s',
          door.name,
          AladdinConnect.describeError(error),
        );
      }
    });
    this.log.debug('[API] Status subscription added for door %s [token=%s]', door.name, token);

    // When this is the first subscription, start polling to publish updates.
    if (isFirstSubscription) {
      this.schedulePoll(0);
    }
    return token;
  }

  // noinspection JSUnusedGlobalSymbols
  unsubscribe(token: Token): void {
    PubSub.unsubscribe(token);
    this.log.debug('[API] Status subscription removed for token %s', token);
  }

  private schedulePoll(delayMs: number): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    this.pollTimer = null;
    // Stop polling when there are no active subscriptions.
    if (PubSub.countSubscriptions(AladdinConnect.PUB_SUB_DOOR_STATUS_TOPIC) === 0) {
      this.log.debug('[API] There are no door status subscriptions; skipping poll');
      return;
    }
    this.log.debug('[API] Polling status for all doors');
    let nextPollMs: number;
    try {
      const doors = await this.getAllDoors();
      if (this.consecutivePollFailures > 0) {
        this.log.info(
          '[API] Genie is reachable again after %d failed poll(s)',
          this.consecutivePollFailures,
        );
      }
      this.consecutivePollFailures = 0;
      doors.forEach((doorStatus) => {
        PubSub.publish(AladdinConnect.doorStatusTopic(doorStatus), doorStatus);
      });
      this.settlePendingCommands(doors);
      const moving = doors.some((door) =>
        [AladdinDoorStatus.OPENING, AladdinDoorStatus.CLOSING].includes(door.status),
      );
      nextPollMs =
        moving || this.pendingCommands.size > 0
          ? AladdinConnect.FAST_POLL_INTERVAL_MS
          : this.pollIntervalMs;
    } catch (error: unknown) {
      this.settlePendingCommands([]);
      this.consecutivePollFailures++;
      nextPollMs = Math.min(
        AladdinConnect.MAX_BACKOFF_MS,
        this.pollIntervalMs * 2 ** Math.min(this.consecutivePollFailures, 10),
      );
      // Log the first failure loudly and the rest quietly, so an outage doesn't flood the log.
      this.log[this.consecutivePollFailures === 1 ? 'error' : 'debug'](
        '[API] Failed to get door status (%s); retrying in %ds',
        AladdinConnect.describeError(error),
        Math.round(nextPollMs / 1000),
      );
    }
    // A command may have scheduled a sooner poll while this one was in flight; keep that one.
    if (!this.pollTimer) {
      this.schedulePoll(nextPollMs);
    }
  }

  /**
   * Stop fast polling for commands that have finished: the door reached the commanded position or
   * Genie reported a timeout, or the command ran past COMMAND_TIMEOUT_MS.
   */
  private settlePendingCommands(doors: AladdinDoor[]): void {
    const now = Date.now();
    for (const [key, { target, deadline }] of this.pendingCommands) {
      const door = doors.find((d) => AladdinConnect.doorKey(d) === key);
      // Only the timeout for this command's direction counts; a door can still show a timeout
      // from an earlier attempt in the other direction when the new command is sent.
      const finished =
        target === AladdinDesiredDoorStatus.OPEN
          ? [AladdinDoorStatus.OPEN, AladdinDoorStatus.TIMEOUT_OPENING]
          : [AladdinDoorStatus.CLOSED, AladdinDoorStatus.TIMEOUT_CLOSING];
      const arrived = door !== undefined && finished.includes(door.status);
      if (arrived || now >= deadline) {
        this.pendingCommands.delete(key);
      }
    }
  }

  async getAllDoors(): Promise<AladdinDoor[]> {
    return this.lock.acquire(AladdinConnect.DOOR_STATUS_LOCK, async (): Promise<AladdinDoor[]> => {
      const response: AxiosResponse<AladdinDevicesEntity> = await this.withAccessToken((token) =>
        this.session.get(`https://${AladdinConnect.API_HOST}/devices`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      if (this.config.logApiResponses) {
        this.log.debug('[API] Configuration response: %s', JSON.stringify(response.data));
      }

      return response.data.devices.flatMap((device) =>
        device.doors.map((door) => {
          const name = door?.name || 'Garage Door';
          const status = door?.status ?? AladdinDoorStatus.UNKNOWN;
          const linkStatus = door?.link_status ?? AladdinLink.UNKNOWN;
          const batteryLevel = door?.battery_level ?? 0;
          const fault = !!door?.fault;
          return {
            deviceId: device.id,
            id: door.id,
            index: door.door_index,
            serialNumber: device.serial_number,
            name,
            // The devices that do not have batteries report a level of 0.
            // I could not identify a better way to figure this out as I only have
            // non-battery devices.
            hasBatteryLevel: (door.battery_level ?? 0) > 0,
            ownership: device.ownership,
            status: status,
            batteryPercent:
              linkStatus === AladdinLink.CONNECTED && batteryLevel > 0 ? batteryLevel : null,
            fault,
          };
        }),
      );
    });
  }

  async setDoorStatus(door: AladdinDoor, desiredStatus: AladdinDesiredDoorStatus): Promise<void> {
    await this.lock.acquire(AladdinConnect.DOOR_STATUS_LOCK, async () => {
      const command = desiredStatus === AladdinDesiredDoorStatus.OPEN ? 'OPEN_DOOR' : 'CLOSE_DOOR';
      let response: AxiosResponse;
      try {
        response = await this.withAccessToken((token) =>
          this.session.post(
            `https://${AladdinConnect.API_HOST}/command/devices/${door.deviceId}/doors/${door.index}`,
            { command },
            { headers: { Authorization: `Bearer ${token}` } },
          ),
        );
      } catch (error: unknown) {
        this.log.error(
          '[API] An error occurred sending command %s to door %s; %s',
          command,
          door.name,
          AladdinConnect.describeError(error),
        );
        throw error;
      }

      if (this.config.logApiResponses) {
        this.log.debug('[API] Genie %s response: %s', command, JSON.stringify(response.data));
      }
    });
    // Poll fast, starting almost immediately, until the door gets there, so HomeKit sees it start
    // moving within a second or two instead of at the next regular poll.
    this.pendingCommands.set(AladdinConnect.doorKey(door), {
      target: desiredStatus,
      deadline: Date.now() + COMMAND_TIMEOUT_MS,
    });
    this.schedulePoll(AladdinConnect.COMMAND_FIRST_POLL_DELAY_MS);
  }

  /**
   * Run an API request with a valid access token. If Genie rejects the token (401), get a new one
   * and try once more; a 401 means the request was not carried out, so repeating it is safe.
   */
  private async withAccessToken<T>(request: (token: string) => Promise<T>): Promise<T> {
    try {
      return await request(await this.getAccessToken());
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        this.log.debug('[API] Access token was rejected; getting a new one');
        this.accessToken = null;
        return request(await this.getAccessToken());
      }
      throw error;
    }
  }

  private async getAccessToken(): Promise<string> {
    return this.lock.acquire(AladdinConnect.AUTH_LOCK, async () => {
      if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
        return this.accessToken;
      }
      // Prefer the refresh token so the password is only sent when it has to be.
      if (this.refreshToken) {
        try {
          return await this.authenticate('REFRESH_TOKEN_AUTH');
        } catch (error: unknown) {
          // A network error or outage says nothing about the refresh token, and a password login
          // would fail the same way, so only give up on the token when Cognito rejects it.
          if (!AladdinConnect.isNotAuthorized(error)) {
            this.log.debug(
              '[API] Token refresh failed (%s); keeping the refresh token',
              AladdinConnect.describeError(error),
            );
            throw error;
          }
          // Expected when the refresh token expires (every 30 days by default); if it shows up
          // every hour, refreshes are being rejected and every renewal costs a password login.
          this.log.warn(
            '[API] Refresh token was rejected (%s); logging in with the password',
            AladdinConnect.describeError(error),
          );
          this.refreshToken = null;
        }
      }
      try {
        return await this.authenticate('USER_PASSWORD_AUTH');
      } catch (error: unknown) {
        this.log.error(
          '[API] Failed to log in to Aladdin Connect; %s',
          AladdinConnect.describeError(error),
        );
        throw error;
      }
    });
  }

  private async authenticate(flow: 'USER_PASSWORD_AUTH' | 'REFRESH_TOKEN_AUTH'): Promise<string> {
    // Cognito computes the secret hash from its own username for the account, which can differ
    // from the email address the user logs in with; refreshes must use that one.
    const hashUser =
      flow === 'REFRESH_TOKEN_AUTH' && this.cognitoUsername
        ? this.cognitoUsername
        : this.config.username;
    const secretHash = createHmac('sha256', AladdinConnect.AUTH_CLIENT_SECRET)
      .update(hashUser + AladdinConnect.AUTH_CLIENT_ID)
      .digest('base64');
    const authParameters =
      flow === 'USER_PASSWORD_AUTH'
        ? {
            USERNAME: this.config.username,
            PASSWORD: this.config.password,
            SECRET_HASH: secretHash,
          }
        : { REFRESH_TOKEN: this.refreshToken, SECRET_HASH: secretHash };

    const response: AxiosResponse<AwsCognitoInitiateAuthResponse> = await this.session.post(
      `https://${AladdinConnect.AUTH_HOST}`,
      {
        ClientId: AladdinConnect.AUTH_CLIENT_ID,
        AuthFlow: flow,
        AuthParameters: authParameters,
      },
      {
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
        },
      },
    );

    const result = response.data?.AuthenticationResult;
    if (!result?.AccessToken) {
      throw new Error('Login response did not contain an access token');
    }
    this.accessToken = result.AccessToken;
    this.accessTokenExpiresAt =
      Date.now() +
      Math.max(0, (result.ExpiresIn ?? 0) - AladdinConnect.TOKEN_EXPIRY_MARGIN_S) * 1000;
    // Refresh responses do not include a new refresh token; keep the existing one.
    this.refreshToken = result.RefreshToken ?? this.refreshToken;
    this.cognitoUsername =
      AladdinConnect.cognitoUsernameFrom(result.IdToken) ?? this.cognitoUsername;
    this.log.debug(
      '[API] %s; token valid for %ds',
      flow === 'USER_PASSWORD_AUTH' ? 'Logged in' : 'Refreshed access token',
      result.ExpiresIn,
    );
    return this.accessToken;
  }

  private static cognitoUsernameFrom(idToken: string | undefined): string | null {
    try {
      const payload = JSON.parse(Buffer.from(idToken?.split('.')[1] ?? '', 'base64url').toString());
      return typeof payload['cognito:username'] === 'string' ? payload['cognito:username'] : null;
    } catch {
      return null;
    }
  }

  /** Whether Cognito rejected the credentials, as opposed to the request failing. */
  private static isNotAuthorized(error: unknown): boolean {
    if (!axios.isAxiosError(error) || error.response?.status !== 400) {
      return false;
    }
    const type = (error.response.data as { __type?: string } | undefined)?.__type ?? '';
    return type.endsWith('NotAuthorizedException');
  }

  /** A short, log-friendly description of an error, including Genie/Cognito's own message. */
  static describeError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const data = error.response?.data as { message?: string; __type?: string } | undefined;
      const detail = data?.message || data?.__type;
      if (status) {
        return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
      }
      return error.code ? `${error.code}: ${error.message}` : error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }

  private get pollIntervalMs(): number {
    return Math.max(
      AladdinConnect.DOOR_STATUS_POLL_INTERVAL_MS_MIN,
      Math.min(
        AladdinConnect.DOOR_STATUS_POLL_INTERVAL_MS_MAX,
        this.config.doorStatusPollInterval ?? AladdinConnect.DOOR_STATUS_POLL_INTERVAL_MS_DEFAULT,
      ),
    );
  }

  private static doorKey(door: Pick<AladdinDoor, 'deviceId' | 'index'>): string {
    return `${door.deviceId}.${door.index}`;
  }

  private static doorStatusTopic(door: AladdinDoor): string {
    return `${AladdinConnect.PUB_SUB_DOOR_STATUS_TOPIC}.${AladdinConnect.doorKey(door)}`;
  }
}
