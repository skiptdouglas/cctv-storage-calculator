// Inlines src/calc.js into src/page.html and writes two single-file builds:
//   dist/index.html    — complete HTML document; open directly or host anywhere.
//                        Fonts are embedded (src/fonts.css), so it works offline.
//   dist/artifact.html — body fragment for hosts that supply their own <html>/<head>
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const page = fs.readFileSync(path.join(root, 'src/page.html'), 'utf8')
const calc = fs.readFileSync(path.join(root, 'src/calc.js'), 'utf8')
const fonts = fs.readFileSync(path.join(root, 'src/fonts.css'), 'utf8')

for (const marker of ['<!-- @calc -->', '<!-- @fonts -->']) {
  if (!page.includes(marker)) throw new Error(`src/page.html is missing the ${marker} marker`)
}
const fragment = page
  .replace('<!-- @fonts -->', () => `<style>\n${fonts}</style>`)
  .replace('<!-- @calc -->', () => `<script>\n${calc}</script>`)

const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'">
<meta name="referrer" content="no-referrer">
<style>body{margin:0}[hidden]{display:none!important}</style>
</head>
<body>
${fragment}
</body>
</html>
`

fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
fs.writeFileSync(path.join(root, 'dist/index.html'), doc)
fs.writeFileSync(path.join(root, 'dist/artifact.html'), fragment)
console.log('Built dist/index.html and dist/artifact.html')
