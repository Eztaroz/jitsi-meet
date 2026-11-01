-- Refuses a client that does not announce that it obeys move commands (ADR 0010), so that everyone in a room can
-- always be moved by the coordinator. The fork's web client announces it in its first presence, as the
-- local participant property "coordinatorMoveSupport"; the mobile apps and other clients do not.
--
-- Load it on the MUC component (XMPP_MUC_MODULES=require_move_support in docker-jitsi-meet).
--
-- Exempt are only the XMPP hosts listed in the option "muc_require_move_support_exempt_hosts", set on the MUC
-- component (XMPP_MUC_CONFIGURATION in docker-jitsi-meet). It defaults to the auth domain (Jicofo) and the recorder
-- bot's hidden domain, as docker-jitsi-meet names them, "auth.<domain>" and "recorder.<domain>". Every other host,
-- the main domain and the guest domain included, must announce move support. A component added later, such as a
-- SIP gateway (Jigasi), is refused until its host is added to the list.

local jid = require "util.jid";
local st = require "util.stanza";
local is_healthcheck_room = module:require "util".is_healthcheck_room;

local muc_domain_base = module:get_option_string("muc_mapper_domain_base");
if not muc_domain_base then
    module:log("warn", "No 'muc_domain_base' option set, disabling the move support requirement.");
    return ;
end

local exempt_hosts = module:get_option_set("muc_require_move_support_exempt_hosts",
    { "auth." .. muc_domain_base, "recorder." .. muc_domain_base });

module:hook("muc-occupant-pre-join", function (event)
    local room, occupant, stanza, origin = event.room, event.occupant, event.stanza, event.origin;

    if is_healthcheck_room(room.jid) or exempt_hosts:contains(jid.host(occupant.bare_jid)) then
        return;
    end
    if stanza:get_child_text('jitsi_participant_coordinatorMoveSupport') == 'true' then
        return;
    end

    module:log("info", "Refusing a client that does not announce move support");
    origin.send(st.error_reply(stanza, "cancel", "not-allowed", "This client cannot be moved between rooms"));

    return true;
end, 99);
