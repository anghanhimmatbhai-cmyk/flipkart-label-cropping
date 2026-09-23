# LabelFlow — Flipkart label cropper

A browser based React app that accepts a print-label PDF and creates a new PDF with the top shipping-label area from every page. Output pages are 4.1 × 6 inches at 203 DPI. PDF processing happens locally in the browser.

## Start the website

Install Node.js, open a terminal in this folder, then run:

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. The server binds to the local network so coworkers on the same office Wi-Fi or LAN can open `http://<this-computer-ip>:5173` in a browser. Find the computer's IPv4 address with `ipconfig` in PowerShell. Keep this computer and the terminal running while coworkers use the site. If port 5173 is already in use, Vite prints another port; use that port in the URL.

For a built version, run `npm run build` and then `npm run preview`. It will be available to the office network on port 4173. The computer hosting it must stay on and connected to the network.

## Deploy to GitHub Pages

The workflow in `.github/workflows/deploy-pages.yml` builds and deploys the site whenever code is pushed to `main`.

1. Create a GitHub repository and push this project to its `main` branch.
2. In the repository, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
3. Open the **Actions** tab and wait for **Deploy to GitHub Pages** to finish. GitHub will show the published address in the workflow run or under **Settings → Pages**.

GitHub Pages sites are publicly available on the internet, even when the source repository is private. The label PDF is still processed locally in each visitor's browser; it is not uploaded by this app.

## Automatic crop behavior

For each A4 source page the cropper scans a 3.42 × 5 inch window around the top label and selects its horizontal position by printed detail. The crop leaves a small, balanced margin around the label and stops before the invoice below. It then scales that region to 4.1 × 6 inches at 203 DPI. Label-sized input pages are preserved. Each page is processed independently.
