/* global interfaceConfig */

// Appended to the web image's interface_config.js (see Dockerfile): the meeting shows the hospital's name and logo
// top left, in place of Jitsi's, and the logo links to the hospital's site. The name before a meeting starts is in
// title.html.
interfaceConfig.APP_NAME = 'ระบบ Telemedicine โรงพยาบาลสงขลานครินทร์';
interfaceConfig.DEFAULT_LOGO_URL = 'images/hospital-logo.png';
interfaceConfig.JITSI_WATERMARK_LINK = 'https://hospital.psu.ac.th/';
