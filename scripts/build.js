// Inlines src/calc.js into src/page.html and writes two single-file builds:
//   dist/index.html    — complete HTML document; open directly or host anywhere
//   dist/artifact.html — body fragment for hosts that supply their own <html>/<head>
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const page = fs.readFileSync(path.join(root, 'src/page.html'), 'utf8')
const calc = fs.readFileSync(path.join(root, 'src/calc.js'), 'utf8')

if (!page.includes('<!-- @calc -->')) throw new Error('src/page.html is missing the <!-- @calc --> marker')
const fragment = page.replace('<!-- @calc -->', () => `<script>\n${calc}</script>`)

const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
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
