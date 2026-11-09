-- Protects patients in Prosody, in every room: their own room, a lounge, anywhere. A patient is an occupant whose
-- token carries the patient role marker. Staff stay moderators, so that they can mute, ask to unmute and run the
-- consultation.
--
-- Jicofo, with JWT authentication on, makes every participant with a token an owner, and with auto-owner on, the first
-- participant of a room; a moderator can also grant moderator to anyone from the participants pane. None of them knows
-- who is a patient. So this refuses, whoever asks:
--   - the owner and admin affiliations for a patient, either of which makes them a moderator;
--   - the moderator role for a patient, asked for directly;
--   - kicking a patient, and demoting a patient to a visitor, when a staff member asks (ADR 0012): either would take
--     the patient out of their own room and end its consultation mid-encounter. The system's own kicks (the
--     coordinator service's, Jicofo's) stay.
-- Ending the meeting for everyone in a patient's own room is refused by mod_end_conference, which handles that message.
--
-- Load it on the MUC component (XMPP_MUC_MODULES=muc_patient_never_moderator in docker-jitsi-meet), with the option
-- "muc_patient_marker" set on the component (XMPP_MUC_CONFIGURATION), in the same form as the recorder bot's and the
-- coordinator service's patient marker: "user.<claim>=<value>" for a claim in the token's context.user, or
-- "group=<value>" for its context.group. Values are compared as text. It needs patient_marker.lib.lua beside it.

local jid = require "util.jid";
local st = require "util.stanza";
local util = module:require "util";
local is_admin = util.is_admin;
local is_healthcheck_room = util.is_healthcheck_room;

local marker = module:get_option_string("muc_patient_marker");
if not marker then
    module:log("error", "No 'muc_patient_marker' option set: patients are not protected.");
    return ;
end

local patients = module:require("patient_marker").new(module, marker);
if not patients then
    return ;
end

local is_patient_jid = patients.is_patient_jid;
local is_patient_occupant = patients.is_patient_occupant;

local moderating_affiliations = { owner = true; admin = true };

module:hook("muc-pre-set-affiliation", function (event)
    if not moderating_affiliations[event.affiliation] or is_healthcheck_room(event.room.jid)
        or not is_patient_jid(event.jid) then
        return;
    end

    module:log("info", "Refusing the %s affiliation for a patient in %s", event.affiliation, event.room.jid);
    event.allowed = false;
    event.error = { type = "cancel", condition = "not-allowed" };
end, 100);

--- Whether the one who asks to change a role is a user's client session, and not the system: the actor is the
-- requester's real JID for a client, and true for Prosody's own modules (the coordinator service's kicks, for one).
local function is_client_actor(actor)
    return type(actor) == "string" and not is_admin(jid.bare(actor));
end

module:hook("muc-pre-set-role", function (event)
    if is_healthcheck_room(event.room.jid) or not is_patient_occupant(event.occupant) then
        return;
    end

    if event.role == "moderator" then
        module:log("info", "Refusing the moderator role for a patient in %s", event.room.jid);
    elseif (event.role == nil or event.role == "none") and is_client_actor(event.actor)
        and jid.bare(event.actor) ~= event.occupant.bare_jid then
        -- No role is a kick.
        module:log("info", "Refusing to kick a patient from %s", event.room.jid);
    else
        return;
    end

    event.allowed = false;
    event.error = "cancel";
    event.condition = "not-allowed";
end, 100);

-- The web client demotes a participant to a visitor with an endpoint message that mod_visitors_component acts on.
module:hook("jitsi-endpoint-message-received", function (event)
    local data, room = event.message, event.room;

    if not data or data.type ~= "visitors" or data.action ~= "demote-request" or type(data.id) ~= "string"
        or is_healthcheck_room(room.jid) then
        return;
    end

    local target = room:get_occupant_by_nick(room.jid .. "/" .. data.id);
    if not target or not is_patient_occupant(target) then
        return;
    end

    module:log("info", "Refusing to demote a patient to a visitor in %s", room.jid);
    event.origin.send(st.error_reply(event.stanza, "cancel", "not-allowed"));

    return true; -- halts processing: the visitors module never sees it
end, 100);
