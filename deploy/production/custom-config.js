// Appended to the web server's config.js by docker-jitsi-meet. The same markers as the services': PATIENT_MARKER and
// VIDEO_PLAYER_MARKER in .env. The client hides the buttons that end a patient's room or remove the patient, and gives
// no menu on the video player's tile.
config.patientMarker = 'user.hospital_role=patient';
config.videoPlayerMarker = 'user.hospital_role=video_player';
