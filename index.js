// Local-dev entrypoint: lets Opencode load this repo directory directly
// (`"plugins": ["/path/to/repo"]`), which requires an `index` module in the
// configured directory. This is the same module the npm package ships
// (`package.json` -> `dist/index.js`); run `npm run build` first.
export * from "./dist/index.js"
export { default } from "./dist/index.js"
