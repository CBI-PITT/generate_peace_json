A web GUI to create JSON tasks for the PEACE pipeline (peace_pipe_line_slurm repo).

Extendable by plugins. Plugins can be placed in the 'plugins' folder and structured same as an example 'rembg' plugin

### Run on slogin
- ssh lab@slogin.cbiserver.pitt.edu <br/>
- conda activate peace-flask <br/>
- cd /h20/CBI/Iana/src/generate_peace_json/flask_app <br/>
- python app.py <br/>


This will run the app at slogin.cbiserver.pitt.edu:1313 <br/>


### Run a dev instance:
- create an environment with Flask and WTForms <br/>
- activate the environment <br/>
- git clone this repo <br/>
- cd to it <br/>
- run python app.py <br/>
- go to http://127.0.0.1:1313/ <br/>
