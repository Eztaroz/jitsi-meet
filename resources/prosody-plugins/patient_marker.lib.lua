-- Recognises patients in Prosody, by the same marker as the recorder bot's and the coordinator service's: an
-- occupant whose token carries it. Shared by mod_muc_patient_never_moderator and mod_end_conference.
--
-- The marker is "user.<claim>=<value>" for a claim in the token's context.user, or "group=<value>" for its
-- context.group. Values are compared as text.
--
-- Usage, with the marker option's text (nil when the option is not set):
--     local patients = module:require("patient_marker").new(module, marker);
-- It returns nil, after logging why, when the marker is not set or not of either form.

local jid = require "util.jid";

local function new(module, marker)
    if not marker then
        return nil;
    end

    local marker_claim, marker_value = marker:match("^user%.([^=]+)=(.+)$");
    local marker_group = marker:match("^group=(.+)$");
    if not (marker_claim or marker_group) then
        module:log("error", "The 'muc_patient_marker' option is neither user.<claim>=<value> nor group=<value>: %s",
            marker);
        return nil;
    end

    local patients = {};

    --- Whether a client session belongs to a patient, by its token.
    function patients.is_patient_session(session)
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
    function patients.is_patient_jid(bare_jid)
        local bare_session = prosody.bare_sessions[jid.bare(bare_jid)];

        if bare_session then
            for _, session in pairs(bare_session.sessions) do
                if patients.is_patient_session(session) then
                    return true;
                end
            end
        end

        return false;
    end

    --- Whether an occupant is a patient, by the sessions they are in the room with.
    function patients.is_patient_occupant(occupant)
        for real_jid in occupant:each_session() do
            if patients.is_patient_session(prosody.full_sessions[real_jid]) then
                return true;
            end
        end

        return false;
    end

    --- Whether a room is a patient's own room, that is, whether a patient is in it. A patient never moves, so a
    -- patient is only ever in their own room (ADR 0011).
    function patients.room_has_patient(room)
        for _, occupant in room:each_occupant() do
            if patients.is_patient_occupant(occupant) then
                return true;
            end
        end

        return false;
    end

    return patients;
end

return { new = new };
