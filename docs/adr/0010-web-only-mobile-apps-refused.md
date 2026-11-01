# Web only: mobile apps are refused, their code is kept

Every participant must be movable (ADR 0008), and only the fork's web client obeys move commands. Rather than port moves to the mobile apps, the deployment supports the web client only: deep linking is disabled so a phone opens the link in its browser (Chrome on Android, Safari on iOS), and Prosody refuses to let a client join a room unless it announces that it supports moves, apart from the recorder bot and the deployment's own components.

## Considered Options

- Delete the mobile apps' code (`android/`, `ios/`, `react-native-sdk/`, `*.native.*` files, `react/features/mobile/`): rejected for now, because every merge from upstream jitsi-meet would then conflict in hundreds of files, while refusing the apps gives users the same result.
