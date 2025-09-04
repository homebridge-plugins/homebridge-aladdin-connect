# Homebridge Aladdin Connect Plugin

Homebridge Aladdin Connect is a TypeScript-based plugin for [Homebridge](https://homebridge.io/) that integrates [Genie Aladdin Connect](https://www.geniecompany.com/aladdin-connect-by-genie) garage door controllers with Apple HomeKit.

Always reference these instructions first and fallback to search or bash commands only when you encounter unexpected information that does not match the info here.

## Working Effectively

Bootstrap, build, and test the repository:
- Ensure Node.js 18, 20, or 22 is installed (`node --version`)
- `npm install` -- takes ~45 seconds. NEVER CANCEL. Set timeout to 60+ seconds.
- `npm run build` -- takes ~3 seconds. Compiles TypeScript to JavaScript in `dist/` folder. NEVER CANCEL.
- `npm run lint` -- takes ~3 seconds. Runs ESLint and Prettier checks. NEVER CANCEL.

Link plugin for development testing:
- ALWAYS run the bootstrapping steps first.
- `npm link` -- links plugin to global npm for Homebridge discovery.
- `npm run watch` -- auto-builds and restarts Homebridge on code changes. NEVER CANCEL. Runs continuously.

Run Homebridge manually for testing:
- Create `config/config.json` with valid Aladdin Connect credentials:
  ```json
  {
    "platforms": [{
      "platform": "GenieAladdinConnect",
      "name": "Garage Door",
      "username": "<email>",
      "password": "<password>"
    }]
  }
  ```
- `./node_modules/.bin/homebridge -I -D --user-storage-path ./config` -- starts Homebridge with debug logging.

## Validation

- ALWAYS run through at least one complete development scenario after making changes.
- ALWAYS run `npm run lint` before committing or the CI (.github/workflows/build.yml) will fail.
- Plugin loads successfully even with invalid credentials (fails gracefully with network errors).
- Manual validation: Start Homebridge, verify plugin loads, check logs show "Initializing GenieAladdinConnect platform" and network error messages for invalid credentials.
- No formal test suite exists - the `npm run test` command only runs `npm install` for dependency validation.
- **CRITICAL DEPENDENCY NOTE**: Use the existing package-lock.json. DO NOT run `npm install` with updated dependencies as it may break TypeScript compilation due to Homebridge version conflicts.

## Common Tasks

The following are outputs from frequently run commands. Reference them instead of viewing, searching, or running bash commands to save time.

### Repository Structure
```
.
├── .github/              # GitHub workflows and templates
├── .vscode/              # VS Code settings
├── config/               # Development Homebridge config (gitignored)
├── dist/                 # Compiled JavaScript output (gitignored)
├── src/                  # TypeScript source code
│   ├── aladdinConnect.ts # Main API client for Aladdin Connect service
│   ├── index.ts          # Plugin registration entry point
│   ├── platform.ts       # Main platform implementation
│   ├── platformAccessory.ts # Garage door accessory implementation
│   └── settings.ts       # Plugin constants and settings
├── package.json          # Dependencies and build scripts
├── tsconfig.json         # TypeScript configuration
├── .eslintrc.yaml        # ESLint configuration
├── .prettierrc.yaml      # Prettier formatting rules
├── config.schema.json    # Homebridge Config UI X schema
└── nodemon.json          # Development watch configuration
```

### Key npm Scripts
```json
{
  "build": "rm -rf ./dist && tsc",
  "lint": "npm run eslint && npm run prettier",
  "lint-fix": "npm run eslint-fix && npm run prettier-fix",
  "watch": "npm run build && npm link && nodemon",
  "test": "npm install"
}
```

### Plugin Configuration Schema
The plugin requires valid Aladdin Connect credentials:
- `username`: Email address for Aladdin Connect account
- `password`: Password for Aladdin Connect account
- Optional: battery level thresholds, cache TTL settings, device filtering

### Development Workflow
1. Make code changes in `src/`
2. `npm run lint` to check code style
3. `npm run build` to compile TypeScript
4. `npm run watch` for continuous development with auto-restart
5. Check Homebridge logs for plugin loading and functionality

### Core Files to Monitor
- `src/aladdinConnect.ts` -- Main API client, handles authentication and device communication
- `src/platform.ts` -- Platform plugin implementation, device discovery
- `src/platformAccessory.ts` -- Individual garage door accessory logic
- `package.json` -- Dependencies and build configuration
- `config.schema.json` -- Homebridge UI configuration schema

### Expected Log Output for Successful Plugin Loading
```
[timestamp] Loaded plugin: @homebridge-plugins/homebridge-aladdin-connect@4.2.1
[timestamp] Registering platform '@homebridge-plugins/homebridge-aladdin-connect.GenieAladdinConnect'
[timestamp] [Test Garage Door] Initializing GenieAladdinConnect platform...
[timestamp] Homebridge v2.0.0-beta.23 (HAP v1.1.1-beta.7) (Homebridge) is running on port XXXXX.
[timestamp] [Test Garage Door] [API] An error occurred getting operator oauth token; getaddrinfo ENOTFOUND cognito-idp.us-east-2.amazonaws.com
[timestamp] [Test Garage Door] Failed to load doors from account; retrying in 5 minutes
```

### Common Error Patterns
- Network errors during development are expected with invalid credentials - this indicates plugin is working correctly
- Plugin should load and register platform successfully even without valid auth
- TypeScript compilation errors indicate syntax or type issues
- ESLint errors must be fixed before committing (CI requirement)
- Version conflicts between Homebridge and dependencies can cause module resolution errors

## Plugin Architecture

The plugin follows Homebridge's dynamic platform pattern:
- `index.ts` registers the platform with Homebridge
- `platform.ts` implements device discovery and accessory management
- `platformAccessory.ts` handles individual garage door control and status
- `aladdinConnect.ts` manages API authentication and device communication

Always check these files when making changes to plugin functionality or adding new features.