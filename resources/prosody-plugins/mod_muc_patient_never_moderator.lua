-- Keeps every patient out of the moderator role, in every room: their own room, a station, anywhere. A patient is an
-- occupant whose token carries the patient role marker. Staff stay moderators, so that they can end a consultation
-- for everyone.
--
-- Jicofo, with JWT authentication on, makes every participant with a token an owner, and with auto-owner on, the first
-- participant of a room; a moderator can also grant moderator to anyone from the participants pane. None of them knows
-- who is a patient. So this refuses, whoever asks:
--   - the owner and admin affiliations for a patient, either of which makes them a moderator;
--   - the moderator role for a patient, asked for directly.
--
-- Load it on the MUC component (XMPP_MUC_MODULES=muc_patient_never_moderator in docker-jitsi-meet), with the option
-- "muc_patient_marker" set on the component (XMPP_MUC_CONFIGURATION), in the same form as the recorder bot's and the
-- coordinator service's patient marker: "user.<claim>=<value>" for a claim in the token's context.user, or
-- "group=<value>" for its context.group. Values are compared as text.

local jid = require "util.jid";
local is_healthcheck_room = module:require "util".is_healthcheck_room;

local marker = module:get_option_string("muc_patient_marker");
if not marker then
    module:log("error", "No 'muc_patient_marker' option set: patients are not kept out of the moderator role.");
    return ;
end

local marker_claim, marker_value = marker:match("^user%.([^=]+)=(.+)$");
local marker_group = marker:match("^group=(.+)$");
if not (marker_claim or marker_group) then
    module:log("error", "The 'muc_patient_marker' option is neither user.<claim>=<value> nor group=<value>: %s", marker);
    return ;
end

--- Whether a client session belongs to a patient, by its token.
local function is_patient_session(session)
    if not session then
        return false;
    end
    if marker_claim then
        local user = session.jitsi_meet_context_user;
        local value = type(user) == "table" and user[marker_claim] or nil;

        return value ~= nil and tostring(value) == marker_value;
    end

    return session.jitsi_meet_context_group ~= nil and tostring(session.jitsi_meet_context_group) == marker_group;
end

--- Whether any live session of a bare JID belongs to a patient.
local function is_patient_jid(bare_jid)
    local bare_session = prosody.bare_sessions[jid.bare(bare_jid)];

    if bare_session then
        for _, session in pairs(bare_session.sessions) do
            if is_patient_session(session) then
                return true;
            end
        end
    end

    return false;
end

--- Whether an occupant is a patient, by the sessions they are in the room with.
local function is_patient_occupant(occupant)
    for real_jid in occupant:each_session() do
        if is_patient_session(prosody.full_sessions[real_jid]) then
            return true;
        end
    end

    return false;
end

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

module:hook("muc-pre-set-role", function (event)
    if event.role ~= "moderator" or is_healthcheck_room(event.room.jid) or not is_patient_occupant(event.occupant) then
        return;
    end

    module:log("info", "Refusing the moderator role for a patient in %s", event.room.jid);
    event.allowed = false;
    event.error = "cancel";
    event.condition = "not-allowed";
end, 100);
