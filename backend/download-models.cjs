const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const modelDirectory = path.join(__dirname, 'models')
const models = [
  {
    name: 'fabric defect detector (MIT)',
    filename: 'fabric-defect-detection.onnx',
    minimumBytes: 10 * 1024 * 1024,
    url: 'https://huggingface.co/hazemaaa/fabric-defect-detection/resolve/a24c1f2f1a661f33dd049061796a946afd8267ce/model.onnx?download=true',
  },
  {
    name: 'LaMa inpainting (Apache-2.0)',
    filename: 'inpainting-lama.onnx',
    minimumBytes: 10 * 1024 * 1024,
    url: 'https://huggingface.co/opencv/inpainting_lama/resolve/aee6d22f0a13e5e35af1c9a1c3afd62841fc6f3f/inpainting_lama_2025jan.onnx?download=true',
  },
]

async function downloadModel(model) {
  const destination = path.join(modelDirectory, model.filename)
  try {
    const existing = await fs.promises.stat(destination)
    if (existing.size >= model.minimumBytes) {
      console.log(`${model.name}: already downloaded`)
      return
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const temporary = `${destination}.download`
  console.log(`Downloading ${model.name}…`)
  try {
    let downloadedViaCurl = false
    try {
      await new Promise((resolve, reject) => {
        const request = spawn('curl', [
          '--location', '--fail', '--retry', '5', '--retry-all-errors',
          '--connect-timeout', '20', '--max-time', '900',
          '--output', temporary, model.url,
        ], { stdio: 'inherit', windowsHide: true })
        request.once('error', reject)
        request.once('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`curl exited with code ${code}.`))
        })
      })
      downloadedViaCurl = true
    } catch (curlError) {
      if (curlError.code === 'ENOENT') {
        console.log(`curl not found, falling back to built-in fetch for ${model.name}…`)
        const response = await fetch(model.url)
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
        const fileStream = fs.createWriteStream(temporary)
        const { Readable } = require('node:stream')
        await new Promise((resolve, reject) => {
          Readable.fromWeb(response.body).pipe(fileStream)
            .on('finish', resolve)
            .on('error', reject)
        })
      } else {
        throw curlError
      }
    }
    const downloaded = await fs.promises.stat(temporary)
    if (downloaded.size < model.minimumBytes) {
      throw new Error(`${model.name} download was incomplete (${downloaded.size} bytes).`)
    }
    await fs.promises.rename(temporary, destination)
    console.log(`${model.name}: downloaded (${downloaded.size} bytes)`)
  } catch (error) {
    await fs.promises.rm(temporary, { force: true })
    throw error
  }
}

async function main() {
  await fs.promises.mkdir(modelDirectory, { recursive: true })
  for (const model of models) await downloadModel(model)
}

main().catch((error) => {
  console.error('Model download failed:', error)
  process.exitCode = 1
})
