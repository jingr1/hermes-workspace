#!/usr/bin/env node
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const iconSourcePath = join(__dirname, '../public/agorax-image.png')
const logoSourcePath = join(__dirname, '../public/agorax.png')
const outputDir = join(__dirname, '../public')

function imageDataUri(path) {
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`
}

async function generateIcon(size, filename) {
  const browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: size, height: size },
  })

  const iconDataUri = imageDataUri(iconSourcePath)
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { margin: 0; padding: 0; }
          img { width: 100%; height: 100%; object-fit: contain; }
        </style>
      </head>
      <body><img src="${iconDataUri}" alt="Agorax" /></body>
    </html>
  `

  await page.setContent(html)
  const screenshot = await page.screenshot({ type: 'png' })
  await browser.close()

  const outputPath = join(outputDir, filename)
  writeFileSync(outputPath, screenshot)
  console.log(`✓ Generated ${size}x${size} icon`)
}

async function generateCover() {
  const browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
  })
  const logoDataUri = imageDataUri(logoSourcePath)
  await page.setContent(`<!DOCTYPE html><html><head><style>html,body{margin:0;width:100%;height:100%;background:#F7F8F6}body{display:flex;align-items:center;justify-content:center}img{width:92%;height:92%;object-fit:contain}</style></head><body><img src="${logoDataUri}" alt="Agorax" /></body></html>`)
  const screenshot = await page.screenshot({ type: 'png' })
  await browser.close()
  writeFileSync(join(outputDir, 'cover.png'), screenshot)
  console.log('Generated 1200x630 cover')
}

async function main() {
  console.log('Generating PWA icons...')
  await generateIcon(32, 'agorax-favicon.png')
  await generateIcon(180, 'agorax-apple-touch-icon.png')
  await generateIcon(192, 'agorax-icon-192.png')
  await generateIcon(512, 'agorax-icon-512.png')
  await generateCover()
  console.log('✓ All icons generated successfully!')
}

main().catch(console.error)
