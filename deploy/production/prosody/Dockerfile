# Prosody with this fork's plugins baked in. /prosody-plugins is the image's own plugin directory; /prosody-plugins-custom
# is a volume that a running stack keeps across upgrades, so the plugins must not go there.
#
# Build from the repository root:
#   docker build -f deploy/production/prosody/Dockerfile -t prosody .
ARG JITSI_IMAGE_VERSION=stable
FROM jitsi/prosody:${JITSI_IMAGE_VERSION}

COPY resources/prosody-plugins/mod_coordinator_api.lua \
     resources/prosody-plugins/mod_muc_require_move_support.lua \
     resources/prosody-plugins/mod_muc_patient_never_moderator.lua \
     resources/prosody-plugins/patient_marker.lib.lua \
     resources/prosody-plugins/mod_end_conference.lua \
     /prosody-plugins/
