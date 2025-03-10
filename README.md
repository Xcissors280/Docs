I made a simple server to render google docs as a nice documentation page
you can try it now at https://docs.atserver.us or self host it using the instructions below

first make a google api service account and put its credentials.json file in the main directory
you might have to change the service account email adress in the html if is isnt automatic
then set your default document id in .env and server port in .env and server.us

finally install packages with npm install and start the server with npm start

to use the app just go to localhost:port or the domain you configured
if you want to use a diffrent document just use url/documentid or put the link or id in the field under more options
make sure all documents are properly shared with the serivce account

now im working on a better ui, full markdown rendering, and maybe native docs rendering
