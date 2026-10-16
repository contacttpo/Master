/* theme.js - the app's brand colours for the pages that use the Tailwind CDN (Feedback, Photo upload, Online test).
   Taken from the Campus Placement Tracker logo: cyan-leaning blues + orange. The other pages carry the same colours directly.
   To tune a colour, change it here:  indigo = main blue,  violet/purple = lighter blue accent,  pink/fuchsia = orange accent. */
window.tailwind = window.tailwind || {};
tailwind.config = { theme: { extend: { colors: {
  "indigo": {
    "50": "#ecf3f9",
    "100": "#dce9f4",
    "200": "#bad7ef",
    "300": "#8dbde4",
    "400": "#539bd7",
    "500": "#2c7cbd",
    "600": "#246498",
    "700": "#1e5581",
    "800": "#19466a",
    "900": "#1f3c54",
    "950": "#122331"
  },
  "violet": {
    "50": "#edf6fa",
    "100": "#ddeef5",
    "200": "#bbe1f0",
    "300": "#83c8e4",
    "400": "#39a8d4",
    "500": "#2584aa",
    "600": "#1f6e8d",
    "700": "#1b5f7a",
    "800": "#164f65",
    "900": "#1c414f",
    "950": "#112831"
  },
  "purple": {
    "50": "#f1f8fb",
    "100": "#dfeff5",
    "200": "#bfe3f1",
    "300": "#8bcce6",
    "400": "#3faad5",
    "500": "#2789b0",
    "600": "#207293",
    "700": "#1b607b",
    "800": "#175168",
    "900": "#1c4150",
    "950": "#122a33"
  },
  "fuchsia": {
    "50": "#fdf6f1",
    "100": "#faebe1",
    "200": "#f9d5bd",
    "300": "#f5b68c",
    "400": "#ef8c4a",
    "500": "#e06514",
    "600": "#bc5510",
    "700": "#9c470e",
    "800": "#813a0b",
    "900": "#653617",
    "950": "#3d210e"
  },
  "pink": {
    "50": "#fcf3ee",
    "100": "#faeadf",
    "200": "#f9d4bc",
    "300": "#f4b286",
    "400": "#ee833b",
    "500": "#de6413",
    "600": "#bf5611",
    "700": "#a1490e",
    "800": "#853c0c",
    "900": "#693818",
    "950": "#3b200d"
  },
  "blue": {
    "50": "#f1f6fb",
    "100": "#deeaf5",
    "200": "#c2dcf1",
    "300": "#9cc6e8",
    "400": "#69a8dc",
    "500": "#358ad0",
    "600": "#2871ad",
    "700": "#225f92",
    "800": "#1c4e77",
    "900": "#22435e",
    "950": "#162a3b"
  },
  "sky": {
    "50": "#f3f8fc",
    "100": "#e6f1f8",
    "200": "#c9e3f4",
    "300": "#a0cfec",
    "400": "#75b9e3",
    "500": "#4ba3da",
    "600": "#2784be",
    "700": "#1f6997",
    "800": "#1a5980",
    "900": "#214a63",
    "950": "#152f3f"
  }
} } } };
