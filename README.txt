REFLECTOR ACTIVITY
==================
Shows which D-STAR, YSF and DMR reflectors are busiest right now, ranked by
recent activity. Runs on your own PC and shows a web page that only your own
computer can open.

QUICK START (Windows)
---------------------
1. Unzip this folder somewhere permanent (for example C:\ReflectorActivity).
   Do not run it from inside the zip file.
2. Double-click  start.cmd
3. First run only: type YOUR OWN callsign when asked (or press Enter to skip).
4. Your browser opens http://localhost:8787
   If Windows asks about node.exe and the network, choose Allow.
5. Leave the black window open while you use the app. Close it to stop.

The averages need about 30 minutes of running to fill in.

FULL GUIDE
----------
Open  public\guide.html  in your browser, or click "User guide" in the app
(http://localhost:8787/guide).

IMPORTANT
---------
* Use your own callsign. It is sent to the YSF reflectors that the listener
  joins (listen-only; it never transmits). Leave it blank to disable that.
* The app queries volunteer-run reflectors and websites. Please keep to one
  copy each and do not shorten the polling intervals.
* Numbers are estimates from public, unofficial sources. Provided as is,
  without warranty, for personal amateur-radio use.

Mac/Linux: install Node.js 24 or newer, then run ./start.sh

LICENCE
-------
Reflector Activity is released under the MIT licence (see the file LICENSE).

BUNDLED SOFTWARE
----------------
The Windows zip includes the Node.js runtime (runtime\node.exe), which is
MIT-licensed. Its licence and third-party notices are in runtime\LICENSE-node.txt.
Other libraries in node_modules carry their own licences in their folders.
