# YUTorah Daf Raster Source Findings

## Verified source

The accessible YUTorah Daf host (`cf.yutorah.org`) renders the scanned page as a
normal image inside `#zoomImg`, rather than embedding a PDF. The image is served
from the YUTorah CDN:

```text
https://cdnyutorah.cachefly.net/public/v3/daf/_images_Shas/{Tractate}/gifs_new/{daf}{amud}.gif
```

Examples verified with HTTP requests:

```text
https://cdnyutorah.cachefly.net/public/v3/daf/_images_Shas/Chullin/gifs_new/137a.gif
https://cdnyutorah.cachefly.net/public/v3/daf/_images_Shas/Chullin/gifs_new/137b.gif
```

Both return `200 image/gif` and are actual GIF raster images. A verified sample
is approximately 672 pixels wide. The page loads `jquery.zoom.min.js` and
initializes the image with `zoom({ on: 'grab', touch: true })`.

## Implementation decision

The Daf viewer uses a same-origin Worker endpoint (`/api/daf-image`) that
fetches the CDN GIF, requires an image content type, and streams the response
back to the browser. The GIF is not saved in the repository, D1, R2, or another
YUTorah storage system. This preserves the source site's raster behavior while
avoiding a third-party page/PDF handoff on Android.

The viewer supports:

- עמוד א (`a`)
- עמוד ב (`b`)
- both amudim (`both`)

The existing touch-point zoom and pan are enabled only for these raster scans;
the Sefaria text view does not receive those gestures.

## Source and attribution

Images are sourced from the YUTorah CDN path above. The implementation is a
passthrough and does not mirror or permanently store the files.
