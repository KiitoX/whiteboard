<%
  import mariadb
  import urllib.parse

  query = urllib.parse.parse_qs(env['QUERY_STRING'])
  
  board_id = query['BOARD_ID'][0]

  connection = mariadb.connect(user='whiteboard', database='whiteboard', unix_socket='/var/run/mysqld/mysqld.sock')
  db = connection.cursor()

  method = env['REQUEST_METHOD']
  if method = 'GET':
    pass # dump data of board

  connection.close()
%>
