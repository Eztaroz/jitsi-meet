-- USAGE / DEPLOYMENT
--   This is a server-to-server API for the coordinator service (coordinator/). It is meant to be called only by
--   that service over a controlled network path (Prosody's HTTP port reachable only from internal hosts). It is NOT
--   safe to make it publicly accessible: do not proxy it from the public web server (nginx) and do not expose
--   Prosody's HTTP ports (5280/5281) to the internet.
--
--   Enable it on the main virtual host (XMPP_MODULES=coordinator_api in docker-jitsi-meet) and set:
--     coordinator_api_key_server = "<URL>"
--         where the public keys of the coordinator service are served, as <URL>/<sha256 of the key id>.pem. Required.
--         It is not the key server of the login tokens: the coordinator service's key must not be able to vouch
--         for participants, nor the hospital issuer's key to call this API.
--     coordinator_api_accepted_issuers = { "coordinator" }       (the default)
--     coordinator_api_accepted_audiences = { "coordinator" }     (the default)
--   The Bearer token is an RS256 JWT with the claims iss, aud, sub and a key id (kid) in its header.
--
-- HTTP module with:
--   GET /coordinator/rooms
--     200 { "rooms": [ { "name": <room name>, "occupants": [ {
--         "endpointId": <occupant resource>,
--         "displayName": <the nickname in the presence>,
--         "hidden": <true when not on the main domain, as the recorder bot>,   (Jicofo is left out)
--         "identity": { "user": { <verified user claims as text> }, "group": <text> },   (when verified)
--         "supportsMove": <true when the client announced it obeys moves>,
--         "cancelledMove": <the id of the move the occupant cancelled, if any>
--     } ] } ] }
--     403 missing, malformed or unverifiable token.
--   POST /coordinator/moves   (Content-Type: application/json)
--     { "room": <room name in the address>, "endpointId": <occupant resource>, "move": <the json the client gets> }
--     Sends the occupant a json-message from the room's own address, so that lib-jitsi-meet surfaces it as a message
--     from the server and not from a participant. The client acts on it only then.
--     200 sent, 400 bad request, 403 bad token, 404 no such room or occupant.

local jid = require "util.jid";
local json = require 'cjson.safe';
local st = require "util.stanza";
local util = module:require "util";
local async_handler_wrapper = util.async_handler_wrapper;
local starts_with = util.starts_with;

local muc_domain_prefix = module:get_option_string("muc_mapper_domain_prefix", "conference");
local muc_domain_base = module:get_option_string("muc_mapper_domain_base");
if not muc_domain_base then
    module:log("warn", "No 'muc_domain_base' option set, disabling the coordinator API.");
    return ;
end

-- docker-jitsi-meet loads XMPP_MODULES on the guest virtual host too once guests are enabled; the API belongs on the
-- main one, the only host with token authentication.
if module.host ~= muc_domain_base then
    module:log("debug", "Not the main virtual host, disabling the coordinator API.");
    return ;
end

local key_server = module:get_option_string("coordinator_api_key_server", "");
if key_server == "" then
    module:log("warn", "No 'coordinator_api_key_server' option set, disabling the coordinator API.");
    return ;
end

local muc_domain = muc_domain_prefix .. "." .. muc_domain_base;

local token_util = module:require "token/util".new(module);
token_util:set_asap_key_server(key_server);
token_util:set_asap_accepted_issuers(module:get_option_array("coordinator_api_accepted_issuers", { "coordinator" }));
token_util:set_asap_accepted_audiences(module:get_option_array("coordinator_api_accepted_audiences", { "coordinator" }));
-- The token is not for a room.
token_util:set_asap_require_room_claim(false);

pcall(function() json.encode_empty_table_as_object(false); end);

--- Verifies the request's bearer token.
-- @param request the HTTP request
-- @return true when the token is valid
local function verify_request(request)
    local token = request.headers["authorization"];

    if token and starts_with(token, 'Bearer ') then
        token = token:sub(8, #token);
    else
        return false;
    end

    local verified, reason, msg = token_util:process_and_verify_token({ auth_token = token });
    if not verified then
        module:log("warn", "not a valid token %s %s", tostring(reason), tostring(msg));
        return false;
    end

    return true;
end

--- Describes the verified identity in an occupant's presence, if it has one.
-- @param presence the occupant's presence stanza
-- @return a table or nil
local function identity_of(presence)
    local identity = presence:get_child("identity");
    if not identity then
        return nil;
    end

    local result = {};
    local user = identity:get_child("user");
    if user then
        result.user = {};
        for _, child in ipairs(user.tags) do
            result.user[child.name] = child:get_text();
        end
    end
    local group = identity:get_child_text("group");
    if group then
        result.group = group;
    end

    return result;
end

local function handle_get_rooms(event)
    if not verify_request(event.request) then
        return { status_code = 403; };
    end

    local component = prosody.hosts[muc_domain];
    local muc = component and component.modules.muc;
    local rooms = {};

    if muc then
        for room in muc.each_room() do
            local occupants = {};

            for _, occupant in room:each_occupant() do
                local presence = occupant:get_presence();

                -- Jicofo, the conference focus, is in every room but is not a participant.
                if jid.node(occupant.bare_jid) ~= "focus" then
                    table.insert(occupants, {
                        endpointId = jid.resource(occupant.nick);
                        displayName = presence and presence:get_child_text('nick', 'http://jabber.org/protocol/nick');
                        hidden = jid.host(occupant.bare_jid) ~= muc_domain_base;
                        identity = presence and identity_of(presence);
                        supportsMove = presence ~= nil
                            and presence:get_child_text('jitsi_participant_coordinatorMoveSupport') == 'true';
                        cancelledMove = presence and presence:get_child_text('jitsi_participant_coordinatorMoveCancelled');
                    });
                end
            end

            table.insert(rooms, { name = jid.node(room.jid); occupants = occupants; });
        end
    end

    return {
        status_code = 200;
        headers = { ["Content-Type"] = "application/json"; ["Cache-Control"] = "no-store"; };
        body = json.encode({ rooms = rooms; });
    };
end

local function handle_post_move(event)
    local request = event.request;

    if not verify_request(request) then
        return { status_code = 403; };
    end
    if request.headers.content_type ~= "application/json" or not request.body or #request.body == 0 then
        return { status_code = 400; };
    end

    local params = json.decode(request.body);
    if not params or type(params.room) ~= "string" or type(params.endpointId) ~= "string"
            or type(params.move) ~= "table" then
        return { status_code = 400; };
    end

    local room = util.get_room_from_jid(jid.join(params.room, muc_domain));
    if not room then
        return { status_code = 404; };
    end

    for _, occupant in room:each_occupant() do
        if jid.resource(occupant.nick) == params.endpointId and jid.node(occupant.bare_jid) ~= "focus" then
            local body = json.encode(params.move);
            -- from = room.jid, as mod_time_restricted does, so that it is a message from the server.
            room:route_stanza(st.message({ from = room.jid; to = occupant.jid; })
                :tag('json-message', { xmlns = 'http://jitsi.org/jitmeet' }):text(body):up());
            module:log("info", "Sent a move to an occupant of a room");
            return { status_code = 200; };
        end
    end

    return { status_code = 404; };
end

module:log("info", "Adding http handler for /coordinator/rooms on %s", module.host);
module:depends("http");
module:provides("http", {
    default_path = "/";
    route = {
        ["GET coordinator/rooms"] = function (event) return async_handler_wrapper(event, handle_get_rooms) end;
        ["POST coordinator/moves"] = function (event) return async_handler_wrapper(event, handle_post_move) end;
    };
});
