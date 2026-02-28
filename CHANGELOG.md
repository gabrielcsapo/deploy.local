# Changelog

All notable changes to this project will be documented in this file.

## [3.0.2](https://github.com/gabrielcsapo/deploy.sh/compare/v3.0.1...v3.0.2) (2026-02-28)

### Features

- support schema copied to directory ([47e6b38](https://github.com/gabrielcsapo/deploy.sh/commit/47e6b38d8f5d1dda22ecc62556c2339886432298))

### Bug Fixes

- fix styling in docs site ([9876e01](https://github.com/gabrielcsapo/deploy.sh/commit/9876e01aa1138aea7ff5244eac398fa49a1049eb))
- fixes tests ([c9c3090](https://github.com/gabrielcsapo/deploy.sh/commit/c9c3090929ad88fdc873e5cb5580352ebe96a48c))

### Chores

- run format ([b013082](https://github.com/gabrielcsapo/deploy.sh/commit/b0130827bf46d99ac507b83e5fa63ed7ea7b6757))

## [3.0.1](https://github.com/gabrielcsapo/deploy.sh/compare/v0.2.1...v3.0.1) (2026-02-27)

### Features

- adds deploy list and json schema ([70f1a04](https://github.com/gabrielcsapo/deploy.sh/commit/70f1a045a575953e312e7f51f6337d12e044ffc8))
- improve xterm integration - adds gpu_enabled flags ([f0e88c0](https://github.com/gabrielcsapo/deploy.sh/commit/f0e88c07eddac84d504819e5c8090d65aa287599))
- moves to react-flight-router - improved performance - single deployable for api and serving application - improves mdns caching and tests (7s -> 100ms) local dns resolution ([1c3fea9](https://github.com/gabrielcsapo/deploy.sh/commit/1c3fea92723a1a1f693af0876284f8c8f943e16e))
- deployment overview - fixes issue with proxyAgent keep alive not proxying requests through and showing 502 page - enables auto backups and manual backs up deploy data to new location ([e1ed6c8](https://github.com/gabrielcsapo/deploy.sh/commit/e1ed6c8cb3e97e63be2f957f43b8449db052859c))
- adds memory limit setting in the admin portal ([89db2a9](https://github.com/gabrielcsapo/deploy.sh/commit/89db2a93a266f5d9de31bed40cbb1c1967a184a9))
- improve analytics dashboard ([b2dc040](https://github.com/gabrielcsapo/deploy.sh/commit/b2dc0402c1f6969f1b636a839cc046d29b0ad7a3))
- allows environment variables via dashboard portal ([5622b34](https://github.com/gabrielcsapo/deploy.sh/commit/5622b349291c4a38d91ccad607b548fa98a4db6c))
- optimize docker build with buildkit ([544ca79](https://github.com/gabrielcsapo/deploy.sh/commit/544ca790f95b1f5b49d8de7e5011c3be1b940be1))
- stops bundling gitignored files - adds ignores array to deploy config - consolidates theme - improves discover experience ([8ae50bc](https://github.com/gabrielcsapo/deploy.sh/commit/8ae50bccf31dbadfda6684c34e8c1451d377b652))
- improves deploy pipeline - fixes build logging and generation to be stored while it happens - adds terminal integration for apps ([76e852b](https://github.com/gabrielcsapo/deploy.sh/commit/76e852b2a0bd7c72d94221d2574b1de3e95a8fa9))
- optimize mdns path ([bfb29fa](https://github.com/gabrielcsapo/deploy.sh/commit/bfb29fa353610683725568ff90c7172fd1908531))
- adds deploy.json config, adds extra port mapping, adds discover portal and configuration ([9f1a70b](https://github.com/gabrielcsapo/deploy.sh/commit/9f1a70b29ea30eb86c898c912b3be40e933723c9))
- handles resources with better graph support - adds maintenance in settings ([ab37bd6](https://github.com/gabrielcsapo/deploy.sh/commit/ab37bd6b1caa46209e290f7712e3e4c63ac9b0f7))
- split up server and vite server to improve performance - sets default port to 5050 ([7509c76](https://github.com/gabrielcsapo/deploy.sh/commit/7509c76d862162237ac27727f498e35a57bde1d8))
- improves routing performance - adds a screen to show up when trying to proxy if the app is starting or down - updates docker run to have 4gb allotment for services - adds compression automatically ([97071ef](https://github.com/gabrielcsapo/deploy.sh/commit/97071ef41b4df0c1285b316232e9ba9325e71201))
- use websockets to get realtime deployments and logs ([23cb110](https://github.com/gabrielcsapo/deploy.sh/commit/23cb110d6c6903187965914c31e38832c3438503))
- toggle auto backups and just in time backups ([e5b4050](https://github.com/gabrielcsapo/deploy.sh/commit/e5b405019766664510b03dfeeb37fce100dcf84e))
- build log and tab ([e8c3cf3](https://github.com/gabrielcsapo/deploy.sh/commit/e8c3cf318132f6b26c82c695d77f34edf71d9890))
- handles persistence for data folders - adds auto backups - adds migration via drizzle ([d60db96](https://github.com/gabrielcsapo/deploy.sh/commit/d60db96b050a2de0eaeeb68d232ca475a5f399af))
- handles deploy to show docker build status ([c7dbd76](https://github.com/gabrielcsapo/deploy.sh/commit/c7dbd768206f92f93c91c593bf0994c246f7d8d2))
- handles upload progress ([05bca6a](https://github.com/gabrielcsapo/deploy.sh/commit/05bca6af05ee7d817abbd14996ded915518c6f17))
- handles mdns registration - handles sessions for multiple devices - handles password reset ([63f2d66](https://github.com/gabrielcsapo/deploy.sh/commit/63f2d660c6e4ebb69b2e3533473727e8673b17dc))
- 3.0.0 - major rewrite to utilize rsc ([80cba94](https://github.com/gabrielcsapo/deploy.sh/commit/80cba94a0938711596e581e30e8897bdc7e79c18))

### Bug Fixes

- fix headers sent ([07b5c95](https://github.com/gabrielcsapo/deploy.sh/commit/07b5c95e6e45b71fc5231b42a6ba8aa2241fa165))
- improve the build logs to stream correctly - fix pagination - fix styling for selected list in build history ([d66d603](https://github.com/gabrielcsapo/deploy.sh/commit/d66d60366eefa57ffc17ff0d491c020a8029913c))
- remove oneline ([80a0400](https://github.com/gabrielcsapo/deploy.sh/commit/80a040040ff43e0061ce97ed45fd03ddc00e87a3))
- fix all app names to be lowercase ([df84bd8](https://github.com/gabrielcsapo/deploy.sh/commit/df84bd8c87c0245d27714b5b86aad10f9064ed41))

### Chores

- adds precommit ([3161b97](https://github.com/gabrielcsapo/deploy.sh/commit/3161b97f018170f1c4351a60f5986edd6c9db462))
- vendor mdns ([6b847da](https://github.com/gabrielcsapo/deploy.sh/commit/6b847dae9f67690f577ce756972110791a9082e9))
- updates dependencies ([11a6884](https://github.com/gabrielcsapo/deploy.sh/commit/11a688440d73a5b6105887622b4de37043fde35c))
- make the site description the tagline ([28a3a3e](https://github.com/gabrielcsapo/deploy.sh/commit/28a3a3e81899ecfce07dad06ffc3dc1402e678a7))
- push package-lock ([4cfdba6](https://github.com/gabrielcsapo/deploy.sh/commit/4cfdba6eaad0599c7c2b05d2512ff3dfb95fd823))
- bump woof to latest to ensure it doesn't break in esm ([e9494c4](https://github.com/gabrielcsapo/deploy.sh/commit/e9494c4341ad5b111f080d395d0def15895f1f89))
- fix eslint and run it on pre-commit ([280ca27](https://github.com/gabrielcsapo/deploy.sh/commit/280ca271896d51db40990e2b20633d169f6762ad))
- updates mongoose to latest and fixes register and login commands ([cef6793](https://github.com/gabrielcsapo/deploy.sh/commit/cef67933df09c444f6ee96ee8a26555b48d85509))
- adds release-it ([bb2c5a7](https://github.com/gabrielcsapo/deploy.sh/commit/bb2c5a77d136ec530e34afb0f5e55297a7d01a42))
- remove link from readme ([22a227c](https://github.com/gabrielcsapo/deploy.sh/commit/22a227cc94333e6b5dd76a6d8e15318636c7534d))
- adds github workflow ([b8603d8](https://github.com/gabrielcsapo/deploy.sh/commit/b8603d86563d59e05f392b9fee6a3e2b4cfe1b11))
- adds and runs prettier ([573cf9b](https://github.com/gabrielcsapo/deploy.sh/commit/573cf9b8ec06dba9a64d67e16456341f91efd040))
- update docs and adds screenshots ([ab0b616](https://github.com/gabrielcsapo/deploy.sh/commit/ab0b616cc46a5cac3e9263dce0e521a7da7ecff9))
- fix spinner and logs collection ([ea91802](https://github.com/gabrielcsapo/deploy.sh/commit/ea91802f8fa9d8bf37a7f649752685455389cbeb))
- convert to esm, update multiple packages ([6bfbd43](https://github.com/gabrielcsapo/deploy.sh/commit/6bfbd43fd795c2ca3cfeecd7d80531fb8423749f))
- bump update-notifier to latest ([33d88f7](https://github.com/gabrielcsapo/deploy.sh/commit/33d88f751e6eae374b9f95322ccf9505416eb891))
- migrate from request to axios ([2f41b71](https://github.com/gabrielcsapo/deploy.sh/commit/2f41b71d5146e070fa14f48a5c832eca8a325653))
- bump tar to latest ([446176d](https://github.com/gabrielcsapo/deploy.sh/commit/446176d4f506c671b8a01c10b253ffc85664d612))
- bump express to latest ([c9fb1a3](https://github.com/gabrielcsapo/deploy.sh/commit/c9fb1a354b8150ddb7b1260f50d8191ded3598ef))
- bump body-parser to latest ([c4d2e8f](https://github.com/gabrielcsapo/deploy.sh/commit/c4d2e8f4131da87bd23df16df938ea364d443998))
- bump moment to latest ([f947fd4](https://github.com/gabrielcsapo/deploy.sh/commit/f947fd497c33baaddd785ba3ac7e57620d1a3df4))
- bump turtler to latest ([931a549](https://github.com/gabrielcsapo/deploy.sh/commit/931a54980ba07549f48e4a2df06219bef1f69059))
- bump commander to latest ([abb5085](https://github.com/gabrielcsapo/deploy.sh/commit/abb5085cc249900f33b9e0ade003e473719a8c34))
- bump formidable to latest ([6d17a30](https://github.com/gabrielcsapo/deploy.sh/commit/6d17a307ba5a1c4a9909a4bbb07f16d31b98af89))
- bump inquirer to latest ([3cb6bdd](https://github.com/gabrielcsapo/deploy.sh/commit/3cb6bdd43f7a1b705bee3cc5294dfcd857190820))
- bump dockerode ([88eaac4](https://github.com/gabrielcsapo/deploy.sh/commit/88eaac4b39719d3ce143e2305c6f446074340dd9))
- bump pkg ([d8897b8](https://github.com/gabrielcsapo/deploy.sh/commit/d8897b814754ec0f12471b09e80a5663c13fb990))
- clean up docs, generate api docs to md ([7fd36f4](https://github.com/gabrielcsapo/deploy.sh/commit/7fd36f4ec281ff1e7c5a0e9bffc1dfb027fe22cf))
- upgrade node, migrate to jest, starts website migration ([dcdea95](https://github.com/gabrielcsapo/deploy.sh/commit/dcdea95ecf90490f1829c5905eb81d171889379e))

### Documentation

- updates changelog ([42c4fb9](https://github.com/gabrielcsapo/deploy.sh/commit/42c4fb992bebb0a17e13f9b7d1a9323e789945f7))

### Other

- Update ci.yml ([e6a0e64](https://github.com/gabrielcsapo/deploy.sh/commit/e6a0e6404850a7e2f5af1ec95e294f42bef5dbec))
- Create pages.yml ([b0fa16e](https://github.com/gabrielcsapo/deploy.sh/commit/b0fa16e28b4245bbb99caff5885fb1a6895524ec))
- Update .github/ISSUE_TEMPLATE/bug_report.yml ([0aa9c7b](https://github.com/gabrielcsapo/deploy.sh/commit/0aa9c7ba1726d2fd1fb8289cc0bb6cd4d483f114))
- Update .github/ISSUE_TEMPLATE/bug_report.yml ([d390138](https://github.com/gabrielcsapo/deploy.sh/commit/d3901381aa38a37d46583f224c1104c783a8c362))
- add github ISSUE_TEMPLATE folder ([102f236](https://github.com/gabrielcsapo/deploy.sh/commit/102f236a73fab29550877530466b2aabb1c58a4a))
- bug(fix): tests now run with esm support ([67ea0e6](https://github.com/gabrielcsapo/deploy.sh/commit/67ea0e64ef7e503d4ef436a1ec272add594dd800))
- Release 2.0.0 ([cd45257](https://github.com/gabrielcsapo/deploy.sh/commit/cd4525721332efa97e00d9edfe52a3110f4b31cc))
- fix(bug): readme image is not correctly linked ([a37d901](https://github.com/gabrielcsapo/deploy.sh/commit/a37d901f8ae89e55d20255cf22a092bf35bbba12))
- fix(bug): website baseUrl is incorrect ([25c8088](https://github.com/gabrielcsapo/deploy.sh/commit/25c8088dde65e19fb16c2f5b9f1ca6089dba5685))
- Update README.md ([e4443f4](https://github.com/gabrielcsapo/deploy.sh/commit/e4443f43a7961647c0cd5ecd8f498c78f8dc9ec1))
- 1.0.0 - sub directories would cause deploy to fail, now recursively find the strings and add them manually - delete should delete the current working directories deployment if not specified - Deployment.del removes the instance metadata from the database using the correct query params - refactors CLI to be a class - moves from easy-table to turtler - fixes login and logout functionality was mixed on cli - by default the open command will open the current directory if it is deployed - by default the log command will open the current directory if it is deployed - logs no longer have a - preceding each line - logs trim white space instead of adding an empty line - delete API actually works now, instead of continuously hanging - removes; mkdirp, easy-table, async - adds tryitout for docs page generation - config is now stored in /.deployrc - getCredentials and cacheCredentials are no longer blocking calls, they will happen async - all error responses from the server will contain an error object - not-found (application not deployed) and page-could-not-load (proxy errors) pages are now moved into a static directory - main landing page is rendered with tryitout ([a39f8db](https://github.com/gabrielcsapo/deploy.sh/commit/a39f8db928cc99c02cef67efd83a6341f018c6a1))
- updates location of lcov-server and starbuck ([dd870a1](https://github.com/gabrielcsapo/deploy.sh/commit/dd870a14b760828e50b1ee794debc851779dce47))
- Update .travis.yml ([3dffcba](https://github.com/gabrielcsapo/deploy.sh/commit/3dffcbafc3a6358b83c6ddd0cec72ecbbb77eeb1))
