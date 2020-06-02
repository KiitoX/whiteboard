# whiteboard
A terrible whiteboard run in the browser

## Intro
This was written since I was sort of unsatisfied with the available options

![Screenshot](https://github.com/kiitox/whiteboard/raw/master/src/screenshot.png)

## Dependencies
This is primarily written in vanilla javascript and html5, so it/should/ work in any recent-ish browser. My knowlede is primarily based in es6, though not much care has been given into backward compatibility, I just used what I found on [MDN](https://developer.mozilla.org/en-US/docs/Web/Reference) and what worked in my browser (Firefox).

The server backend is written in Python 3.8 and uses asyncio + [websockets](https://pypi.org/project/websockets/) for client communications, and the [MySQL Connector](https://github.com/mysql/mysql-connector-python) for database operations. Given that I am further using [MariaDB](https://mariadb.com/) for the database and an [Apache](https://httpd.apache.org/) server running a websocket proxy and [Mako Templates](https://www.makotemplates.org/) for a small server-side script, though it could easily be rewritten in PHP I presume...
