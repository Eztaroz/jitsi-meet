# Video player: operator guide

The video player plays a video file into a room as a visible, non-human participant. The coordinator service asks it to play a video in a patient's room and to stop; the service starts one headless Chromium per room, which joins the room with a token the coordinator service issues, publishes the video as its audio and video, and leaves when the video ends or when it is told to stop. The recorder bot records it like any participant, under its own role.

## What the deployment needs

| Piece | What |
|---|---|
| Web | This fork's web build, which carries the page `static/video-player.html`, and the hospital's video files |
| Prosody | The coordinator service's token issuer accepted (as for moved participants). The token carries the video player's role marker, as neither the staff nor the patient marker |
| Recorder bot | `RECORDER_BOT_VIDEO_PLAYER_MARKER` set to the same marker, so that it records the video player under its own role |
| The service | The `video-player` container, which reaches the Jitsi web server and the videobridge |

Build the image with `docker build -t video-player:<version> video-player/` and add `docker-compose.video-player.yml` to the docker-jitsi-meet deployment.

## Settings

| Variable | Default | What |
|---|---|---|
| `VIDEO_PLAYER_API_SECRET` | required | The bearer secret every control API request must carry |
| `VIDEO_PLAYER_JITSI_URL` | required | The Jitsi web server's base URL (the compose file uses `PUBLIC_URL`) |
| `VIDEO_PLAYER_API_PORT` | 8091 | The control API port |
| `VIDEO_PLAYER_MAX_ROOMS` | 2 | How many rooms to play in at once. Each is one headless browser; count them with the recorder bot's when sizing |
| `VIDEO_PLAYER_CHROMIUM_PATH` | Playwright's | The Chromium binary |
| `VIDEO_PLAYER_IGNORE_CERTIFICATE_ERRORS` | off | Accept the web server's certificate without checking it. Test deployments only |

## Control API

Every request carries `Authorization: Bearer <VIDEO_PLAYER_API_SECRET>`. Bind the API to an internal address.

| Request | Answer |
|---|---|
| `GET /health` | 200 `{ status, activeRooms, maxRooms, rooms }` |
| `POST /play` `{ room, token, videoUrl }` | 201 `{ room, status: "playing" }`; 400 bad request; 409 a video is already playing in the room; 503 at capacity; 502 the browser could not start |
| `POST /stop` `{ room }` | 200 `{ room, status: "stopped" }`; 404 nothing plays in the room |

`room` is the room name as the coordinator service uses it, `token` a token for that room, `videoUrl` an `http(s)` URL of a video file hosted by the deployment. A video plays once. There is no callback: when it ends, the room leaves the list in `/health`.
