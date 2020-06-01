<!DOCTYPE html>
<%
  import uuid
  import mariadb

  rand_id = str(uuid.uuid4())

  connection = mariadb.connect(user='whiteboard', database='whiteboard', unix_socket='/var/run/mysqld/mysqld.sock')
  db = connection.cursor()

  try:
    db.setinputsizes((36,))
    db.execute('''
      INSERT INTO boards SET identifier = ?''', (rand_id,))
  except mariadb.IntegrityError:
    pass  # most likely a duplicate identifier, normally try again, for debugging just ignore it

  connection.close()

  env['MAKO_STATUS'] = '307 Temporary Redirect'
  env['MAKO_HEADERS']['Location'] = rand_id
%>
<html>
  <head>
    <title>Creating a new whiteboard</title>
    <link rel="stylesheet" type="text/css" href="res/style.css"/>
  </head>
  <body>
    <h1>Please wait...</h1>
    <h2>If you are not redirected automatically, click <a href="${rand_id}">here</a></h2>
  </body>
</html>
