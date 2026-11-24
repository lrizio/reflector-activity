# Reflector Activity

Find the busiest **D-STAR, YSF and DMR** reflectors right now. Pick a mode and a time window (15, 30 or 60 minutes) and see the reflectors ranked by recent activity, so you can link to one that actually has people on it.

It runs on your own PC and shows a local web page (`http://localhost:8787`). Nothing is uploaded anywhere.

## Download (Windows)

Get **`ReflectorActivity-<version>-windows.zip`** from the [Releases](../../releases) page, unzip it somewhere permanent, and double-click `start.cmd`. Node.js is bundled; nothing to install. On first run it asks for your own callsign (optional, used only by the YSF listener).

Mac / Linux / your own Node: use the `-source.zip`, or clone this repo, install **Node.js 24+**, then:

```sh
npm install --omit=dev
./start.sh        # or: node server.mjs
```

The full **[user guide](public/guide.html)** is also built into the app at `http://localhost:8787/guide`.

## What each mode measures

| Mode | Source | Measure |
|---|---|---|
| D-STAR | ~560 XLX reflectors (UDP status feed) and ~45 DPlus (REF) reflectors that publish a web dashboard | Transmissions and unique stations per 30 min |
| YSF | Reflector list from [DVRef](https://dvref.com/aup/) via Pi-Star's mirror; status queries; listen-only join of the busiest reflectors | Real transmissions for the busiest 50, connected users for the rest |
| DMR | [TGIF Network](https://tgif.network) public last-heard feed | Transmissions per talkgroup (TGIF only; BrandMeister is not included) |

Counts are estimates from public, unofficial sources and only cover the time the app has been running (history is kept for 24 hours).

## Please be a good network citizen

The app queries volunteer-run reflectors and websites, and the YSF listener joins reflectors **listen-only using your callsign**. Use your own callsign, keep to one copy each, and don't shorten the polling intervals. Set `listenTop` to `0` in `config.json` to turn the listener off. Details are in the user guide.

## Build the packages

```powershell
powershell -ExecutionPolicy Bypass -File .\build-package.ps1
```

Produces `dist/ReflectorActivity-<version>-windows.zip` (with Node bundled) and `-source.zip`. The build needs `licenses/NODE-LICENSE-<node version>.txt` for the Node it bundles.

## Licence and disclaimer

Released under the [MIT licence](LICENSE). The Windows package also bundles Node.js, which has its own MIT licence (included as `runtime/LICENSE-node.txt`).

Provided as is, without warranty. You are responsible for how you use it, including your callsign and the load you put on other people's servers. Counts come from public, unofficial sources and may change or disappear without notice.
