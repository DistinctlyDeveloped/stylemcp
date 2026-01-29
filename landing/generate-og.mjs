import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function generateOGImages() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.setViewport({ width: 1200, height: 630 });
  
  const templatePath = `file://${path.join(__dirname, 'og-template.html')}`;
  await page.goto(templatePath, { waitUntil: 'networkidle0' });
  
  await page.evaluate(() => document.fonts.ready);
  await new Promise(r => setTimeout(r, 500));
  
  await page.screenshot({
    path: path.join(__dirname, 'og-image.png'),
    type: 'png'
  });
  console.log('✓ Generated og-image.png');
  
  await page.screenshot({
    path: path.join(__dirname, 'twitter-image.png'),
    type: 'png'
  });
  console.log('✓ Generated twitter-image.png');
  
  await browser.close();
  console.log('Done!');
}

generateOGImages().catch(console.error);
