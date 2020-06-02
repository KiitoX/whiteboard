import asyncio
import pathlib
import ssl
import websockets
import socket

import json
#import mariadb
import mysql.connector

import urllib.parse

import logging
logging.basicConfig(level=logging.INFO)


## this is just a reference for ""documentation"" :)
__outgoing_message_types = [
        "identity",
        "client_joined",
        "client_left",
        "all_clients",
        "all_elements",
        "added",
        "deleted",
        "cleared",
        "ongoing",
        "matches",
]


DOMAIN_NAME = "..."
SSL_CERT_PATH = "/etc/letsencrypt/live/.../fullchain_pem"
SSL_KEY_PATH = "/etc/letsencrypt/live/.../privkey.pem"

DB_USER = "whiteboard"
DB_DATABASE = "whiteboard"
DB_SOCKET = "/var/run/mysqld/mysqld.sock"


db_connection = None
connected_clients = {}


async def send_to_all(url, msg_type, msg_data, client_id):
    message = json.dumps({"type": msg_type, "data": msg_data, "origin": client_id})
    await asyncio.wait([client.send(message) for client in connected_clients[url]])


async def add_client(url, client):
    if url not in connected_clients:
        connected_clients[url] = set()
        db = db_connection.cursor()
        db.execute("SELECT id FROM boards WHERE identifier=%s", (url[1:],))
        res = db.fetchall()
        if not res:
            # reject client, board does not exist
            logging.info("client " + str(hash(client)) + " tried to connect to nonexistent path " + url)
            await client.close()
    else:
        await send_to_all(url, "client_joined", hash(client), "")
    connected_clients[url].add(client)


async def remove_client(url, client):
    connected_clients[url].remove(client)
    if len(connected_clients[url]) == 0:
        del connected_clients[url]
    else:
        await send_to_all(url, "client_left", hash(client), "")


async def send_state(url, client):
    hashes = list(hash(client) for client in connected_clients[url])
    clients_msg = json.dumps({"type": "all_clients", "data": hashes})
    await client.send(clients_msg)
    
    db = db_connection.cursor()
    db.execute("""\
            SELECT contents.id, types.name, contents.content, \
            bounds_lower_x, bounds_upper_x, bounds_lower_y, bounds_upper_y FROM contents \
            INNER JOIN types ON contents.type_id=types.id WHERE \
            board_id=(SELECT id FROM boards WHERE identifier=%s)""", (url[1:],))

    # TODO check out how this could perform betterm clearly json processing is not the way to go
    # (id, type, content)
    results = db.fetchall()
    # => id: {"body": content(str), "type": type}
    #elements = dict((id_, {"type": type_, "body": content}) for (id_, type_, content) in results)

    state_msg = json.dumps({"type": "all_elements", "data": results})
    await client.send(state_msg)


async def send_identity(client):
    message = json.dumps({"type": "identify", "data": hash(client)})
    await client.send(message)


async def handle_message(url, client, message):
    db_connection.ping(reconnect=True)
    db = db_connection.cursor()
    message = json.loads(message)
    if message["type"] == "drawing":
        await send_to_all(url, "ongoing", message["data"], hash(client))
    elif message["type"] == "add":
        type_ = message["data"]["type"]
        body = message["data"]["body"]

        lower_x = min(body[0::2])
        upper_x = max(body[0::2])
        lower_y = min(body[1::2])
        upper_y = max(body[1::2])

        db.execute("""\
                INSERT INTO contents SET \
                board_id=(SELECT id FROM boards WHERE identifier=%s),\
                type_id=(SELECT id FROM types WHERE name=%s),\
                bounds_lower_x=%s, bounds_upper_x=%s,
                bounds_lower_y=%s, bounds_upper_y=%s,
                content=%s""", (url[1:], type_, lower_x, upper_x, lower_y, upper_y, json.dumps(body)))

        db.execute("SELECT LAST_INSERT_ID()")
        element_id, = db.fetchone()
        
        data = {"id": element_id, "properties": message["data"]}
        #, "bounds": [lower_x, upper_x, lower_y, upper_y]}
        await send_to_all(url, "added", data, hash(client))
    elif message["type"] == "del":
        element_id = message["data"]["id"]
        db.execute("DELETE FROM contents WHERE id=%s", (element_id,))
        
        await send_to_all(url, "deleted", message["data"], hash(client))
    elif message["type"] == "get":
        # TODO currently not used
        await send_state(url, client)
    elif message["type"] == "clear":
        # TODO maybe implement something like a vote/veto system??
        # interesting idea, not much of a priority as of now
        db.execute("""\
                DELETE FROM contents WHERE \
                board_id=(SELECT id FROM boards WHERE identifier=%s)""", (url[1:],))
        await send_to_all(url, "cleared", "", "")
    elif message["type"] == "query":
        body = message["data"]
        
        lower_x = min(body[0::2]) - 2
        upper_x = max(body[0::2]) + 2
        lower_y = min(body[1::2]) - 2
        upper_y = max(body[1::2]) + 2
        
        db.execute("""\
                SELECT id FROM contents WHERE \
                board_id=(SELECT id FROM boards WHERE identifier=%s) \
                AND bounds_lower_x <= %s AND bounds_upper_x >= %s \
                AND bounds_lower_y <= %s AND bounds_upper_y >= %s""",
                (url[1:], upper_x, lower_x, upper_y, lower_y))

        matching_ids = list(id_ for (id_,) in db.fetchall())

        message = json.dumps({"type": "matches", "data": {"line": body, "ids": matching_ids}})
        await client.send(message)
    else:
        logging.error("unsupported method: {}", message)


async def manage_state(client, path):
    url = urllib.parse.urlparse(path)
    logging.info("client " + str(hash(client)) + " connected at " + url.path)
    await add_client(url.path, client)
    try:
        await send_identity(client)
        await send_state(url.path, client)
        async for message in client:
            await handle_message(url.path, client, message)
    except websockets.ConnectionClosedOK:
        pass # this is fine and expected
    finally:
        logging.info("client " + str(hash(client)) + " disconnected at " + url.path)
        await remove_client(url.path, client)


ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
fullchain_pem = pathlib.Path(SSL_CERT_PATH)
privkey_pem = pathlib.Path(SSL_KEY_PATH)
ssl_context.load_cert_chain(fullchain_pem, keyfile=privkey_pem)

start_server = websockets.serve(manage_state, DOMAIN, 26273, ssl=ssl_context, family=socket.AF_INET6)

try:
    #db_connection = mariadb.connect(user="whiteboard", database="whiteboard",
    db_connection = mysql.connector.connect(user=DB_USER, database=DB_DATABASE,
            unix_socket=DB_SOCKET, autocommit=True)
    #db_connection.auto_reconnect = True
    asyncio.get_event_loop().run_until_complete(start_server)
    asyncio.get_event_loop().run_forever()
except KeyboardInterrupt:
    pass
finally:
    db_connection.close()
