# Thermocline

A cold plunge / cold dip tracker. Timer, streaks, temperature trend chart, achievement badges and a session log.
Plain HTML, CSS and JS: no build step, no dependencies.

Data is saved in your browser (localStorage). Use **Export log** / **Import log** at the bottom of the page to back up or move it between devices.

## Host on GitHub Pages

1. Create a new repository and upload these files to the root.
2. Go to **Settings > Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`, then Save.
4. After a minute your site is live at `https://<your-username>.github.io/<repo-name>/`.

On a phone, open the link and use **Add to Home Screen** to install it like an app.

## Run locally

Open `index.html` in a browser, or run `python3 -m http.server` in this folder.

## Your existing sessions

`sessions.seed.json` holds the sessions from your original file. Open the site and tap **Import log** to load them. If the repository is public, don't commit that file, because your notes would be visible to anyone.
