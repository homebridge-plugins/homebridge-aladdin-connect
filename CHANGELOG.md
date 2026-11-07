# [4.5.0](https://github.com/homebridge-plugins/homebridge-aladdin-connect/compare/v4.4.7...v4.5.0) (2026-11-07)


### Bug Fixes

* allow retrying a command after the door times out ([5809da2](https://github.com/homebridge-plugins/homebridge-aladdin-connect/commit/5809da2da143f7b6e94d54fc3c6fbac70a4815a1))
* let go of the HomeKit target at the same moment fast polling stops ([06319b7](https://github.com/homebridge-plugins/homebridge-aladdin-connect/commit/06319b71e5f2dbc68aa6ae6c479ef084e947b7ca))


### Features

* faster status updates, token refresh, backoff, safer state handling ([a1d3007](https://github.com/homebridge-plugins/homebridge-aladdin-connect/commit/a1d30072ebad9bcf420c4b7adb02f8339ef3ba0d))



## [4.4.7](https://github.com/homebridge-plugins/homebridge-aladdin-connect/compare/v4.4.6...v4.4.7) (2026-11-06)


### Bug Fixes

* poll fresh status instead of the door cache; make token-reuse test real ([f3e9dd3](https://github.com/homebridge-plugins/homebridge-aladdin-connect/commit/f3e9dd398dbefc61b5fa427469e98c3c5402a7f7))
* use millisecond cache TTLs, invalidate status after commands, stop retrying 4xx ([1428f7a](https://github.com/homebridge-plugins/homebridge-aladdin-connect/commit/1428f7a8741b931883a68db8b1a0a5ee01b9de3e))



## [4.3.4](https://github.com/homebridge-plugins/homebridge-aladdin-connect/compare/v4.3.3...v4.3.4) (2026-09-03)


### Features

* support Node.js 26 and Homebridge v2 ([9558fa1](https://github.com/homebridge-plugins/homebridge-aladdin-connect/commit/9558fa151d16eeb9b9f135b301d87c7c794e5803))



# Changelog

All notable changes to this project will be documented in this file. This project uses [Semantic Versioning](https://semver.org/)

## [4.3.2](https://github.com/homebridge-plugins/homebridge-aladdin-connect/releases/tag/v4.3.2) (2025-09-17)

### What's Changed
- update dependencies

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-aladdin-connect/compare/v4.3.1...v4.3.2

## [4.3.1](https://github.com/homebridge-plugins/homebridge-aladdin-connect/releases/tag/v4.3.1) (2025-01-24)

### What's Changed
- Fix webhook logging wrong plugin - correct references from roomba to aladdin-connect

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-aladdin-connect/compare/v4.3.0...v4.3.1

## [4.3.0](https://github.com/homebridge-plugins/homebridge-aladdin-connect/releases/tag/v4.3.0) (2025-09-04)

### What's Changed
- Add configurable door state change logging option [#69](https://github.com/derek-miller/homebridge-genie-aladdin-connect/pull/69)

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-aladdin-connect/compare/v4.2.2...v4.3.0

## [4.2.2](https://github.com/homebridge-plugins/homebridge-aladdin-connect/releases/tag/v4.2.2) (2025-09-04)

### What's Changed
- Update dependencies to latest versions

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-aladdin-connect/compare/v4.2.1...v4.2.2

## [4.2.1](https://github.com/homebridge-plugins/homebridge-aladdin-connect/releases/tag/v4.2.1) (2024-12-19)

### What's Changed
- Hide input to password field when editing the config in the Homebridge UI by @derek-miller in [#53](https://github.com/derek-miller/homebridge-genie-aladdin-connect/pull/53)

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-aladdin-connect/compare/v4.2.0...v4.2.1
