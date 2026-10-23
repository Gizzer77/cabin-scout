# CabinScout

A free, self-hosted whitetail scouting board for your own land. Map your property, log sightings and trail-cam photos, see how wind and thermals will carry your scent around each stand, and keep a scouting and hunt log, all on your own computer.

- **No account, no cloud, no tracking.** Your data lives in a local `data/` folder.
- **Zero dependencies.** Plain Node.js, nothing to `npm install`.
- **Works with no API keys.** Keys only unlock optional extras.

## Quick start

You need [Node.js 20+](https://nodejs.org).

```bash
git clone https://github.com/Gizzer77/cabin-scout.git
cd cabin-scout
npm start
```

Your browser opens the **setup wizard** at <http://localhost:3000/setup.html>. It takes about two minutes:

1. **Your land:** search an address, tap the map, or use your GPS.
2. **Your hunt:** season dates, tag count, house-distance warning (all optional).
3. **Optional extras:** paste your own API keys if you want them (see below).
4. **Demo property:** keep this checked to explore every feature with fake stands, cameras and sightings.

After that, `npm start` goes straight to the app.

## What it does

| Feature | What you get |
|---|---|
| **Property map** | Satellite and topo maps, boundaries, bedding, food, pinch points, stands, cameras, access routes. |
| **Thermal and scent simulator** | Wind, temperature and terrain turned into a scent cone for each stand, with a best-sit suggestion for the next days. |
| **Sightings and bucks** | Log deer by animal, behavior and heading. See patterns by time of day and weather. |
| **Trail-cam vault** | Track cameras, battery and last check. Optionally pull photos from supported camera services. |
| **Scout Log (phone)** | A mobile page for spots, photos, heard-it-from-here sightings, GPS hunt tracks, bow shot and recovery points, and an offline queue. |
| **Wildlife and predators** | Log bears, coyotes, turkeys and more, with simple pressure notes. |
| **Field app** | `field/` is an offline phone web app (GPS and compass logger). Export a file and import it on the desktop. |
| **MCP uplink** | Let an AI assistant such as Claude read your map and drop suggested pins. Off unless you connect a client. |

## Optional keys

Put these in `.env` (copy `.env.example`) or paste them into the wizard. Each is yours alone and is never sent anywhere except the service it belongs to.

| Variable | Unlocks | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Smarter advisor, photo reading | console.anthropic.com |
| `TELEGRAM_BOT_TOKEN` | Phone Scout Log through a Telegram bot | Message [@BotFather](https://t.me/BotFather) |
| `GOOGLE_MAPS_API_KEY` | Place autocomplete, elevation | Google Cloud console |
| `REGRID_TOKEN` | Parcel lines outside Massachusetts | regrid.com |
| `CABINSCOUT_PORT` | Run on another port (default 3000) | n/a |

Without keys it uses free sources: Esri and OpenTopo tiles, OpenStreetMap search, Open-Meteo weather and elevation, MassGIS parcels for Massachusetts, and a built-in rule-based advisor.

## Using the Scout Log on your phone

The Scout Log is a Telegram Mini App.

1. Create a bot with @BotFather and put its token in the wizard or `.env`, then restart.
2. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
3. Run `npm run mobile`. It opens a temporary free tunnel and starts the server. Message your bot once to lock it to your chat.

Over the tunnel only the Scout Log is reachable, and only with credentials Telegram signs for your chat. The tunnel address changes each restart.

## Privacy and safety

- Everything is stored in `data/` and `.env`. Both are git-ignored. Don't commit them.
- The server listens on `127.0.0.1` only unless you change `HOST`.
- Property owner names come from public parcel records when you use the parcel lookup. Respect landowner permission and local law.
- Sun, wind and thermal output is a planning aid, not a guarantee. Always check legal hunting hours, setbacks and regulations for your area.

## Project layout

```
server.js        HTTP server, REST API, MCP endpoint, setup wizard API
services.js      weather, terrain, parcels, advisor
home.js          property summaries and stand suggestions
scout.js         Scout Log and Telegram bot
public/          the web app (index.html, setup.html, scout.html)
field/           offline phone logger (PWA)
seed.js          the fictional demo property
```

## Contributing

Issues and pull requests are welcome. Keep it dependency-free and keep personal data out of commits. Ideas: more state parcel sources, more species, a metric-units toggle, Docker image, tests.

## License

MIT. See [LICENSE](LICENSE).
