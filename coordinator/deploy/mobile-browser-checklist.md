# Mobile-browser checklist

The deployment is web only: the mobile apps are refused (ADR 0010), and deep linking is off so that a phone opens a room link in its browser. The move notice and its countdown are web features, but nothing in the automated suite runs on a phone: it runs Chrome on desktop only. A human with real devices runs this checklist before a release, and again after a change to the move notice or to the web client's join flow.

## Devices

Run the whole checklist on each of:

- iOS Safari on the current iOS version;
- iOS Safari on the previous iOS version;
- Chrome on Android, on a current version.

Real devices only: an emulator does not behave like a phone when its screen locks or when it switches apps.

## Setup

- A deployment with the coordinator service, as in the [deploy README](README.md).
- A staff member (or a patient) on the phone, with a verified identity token, in a lounge or in a patient's room.
- A coordinator on a computer, on the coordinator screen at `https://<deployment>/coordinator/screen`, ready to move the person on the phone.

Run it once with a staff member on the phone, and once with a patient.

## Checks

For each device, tick every box. Write down the device, the OS and browser version, and what you saw for any box that fails.

### Opening the link

- [ ] Opening the room link from a message or another app opens it in the browser, with no offer to open or install the Jitsi app.
- [ ] No "download the app" page appears at any point.

### Joining

- [ ] The person joins with their token, and the room opens.
- [ ] The microphone and camera permission prompts appear, and once allowed, the camera and microphone work: the coordinator sees the person's video and hears them.

### Being moved, with the countdown

- [ ] When the coordinator moves the person, the notice appears: "You are being moved to another room in N seconds…", counting down from 5. It does not name the destination.
- [ ] The notice is readable and its "Stay here" button is easy to tap at the phone's width.
- [ ] When the countdown ends, the person ends up in the destination without the prejoin page, and the coordinator screen shows the move as done.

### "Stay here"

- [ ] Tapping "Stay here" during the countdown keeps the person in their room.
- [ ] The coordinator screen shows the move as cancelled.
- [ ] The notice goes away, and the room keeps working: audio and video both ways.

### Microphone and camera after a move

Do this with the microphone and camera on, then again with the microphone muted and the camera off before the move.

- [ ] After the move, the microphone and camera are in the state they were in before it.
- [ ] After the move with both on, the camera and microphone work in the destination: the others see and hear the person.
- [ ] After the move with the microphone muted and the camera off, they are still muted and off, and can be turned on.

### Locking the screen or switching apps during a countdown

Start a move, and during the five seconds of the countdown:

- [ ] Lock the screen, wait for the countdown to pass, and unlock. Write down whether the person was moved or stayed, and how the coordinator screen shows the move. A move that ends `failed` with `participant_did_not_arrive` is an acceptable result; a hang, with the screen showing the move in progress for good, is not.
- [ ] Switch to another app for a few seconds, then come back, once before the countdown ends and once after. Write down the same.
- [ ] After either, the person can rejoin or stay in a working room: audio and video work, and the notice does not stay on screen forever.

## Reporting

A box that fails becomes a new issue, with the device, the OS and browser version, the steps, and what happened. Record the date, the build and who ran the checklist where your release notes keep such things.
