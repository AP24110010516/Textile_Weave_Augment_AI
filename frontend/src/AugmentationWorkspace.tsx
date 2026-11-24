import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import JSZip from 'jszip'
import { ArrowDownToLine, ArrowLeft, Bookmark, Check, CircleHelp, Copy, FileImage, LoaderCircle, Upload, WandSparkles } from 'lucide-react'

type Result = { name: string; url: string }
type GenerationPrompts = { positive: string; negative: string }
type AugmentationMode = 'defect-creation' | 'color-variation' | 'dataset-builder'
type SdxlStatus = 'checking' | 'configured' | 'needs-key' | 'unavailable'
type FabricType = 'Cotton' | 'Silk' | 'Denim' | 'Wool' | 'Polyester'
type DefectType = 'Hole' | 'Stain' | 'Scratch' | 'Tear'
type Props = {
  mode: AugmentationMode
  sdxlStatus: SdxlStatus
  onBack: () => void
  onGenerated: (summary: string, images: Result[]) => void
  onSaveImage: (image: Result) => void
}

const dimensions = [
  { width: 1024, height: 1024 }, { width: 1152, height: 896 }, { width: 1216, height: 832 },
  { width: 1344, height: 768 }, { width: 1536, height: 640 }, { width: 640, height: 1536 },
  { width: 768, height: 1344 }, { width: 832, height: 1216 }, { width: 896, height: 1152 },
]
const negativePrompt = 'cartoon, illustration, artificial texture, plastic material, unrealistic fabric, excessive blur, distorted weave, text, watermark, visual artifacts.'

async function prepareImage(file: File): Promise<Blob> {
  let image: ImageBitmap
  try { image = await createImageBitmap(file) }
  catch { throw new Error('Could not read the uploaded image. Please try a different PNG or JPG file.') }
  try {
    const aspectRatio = image.width / image.height
    const size = dimensions.reduce((closest, candidate) =>
      Math.abs(Math.log(aspectRatio / (candidate.width / candidate.height))) < Math.abs(Math.log(aspectRatio / (closest.width / closest.height))) ? candidate : closest)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not prepare the uploaded image. Please try again.')
    const scale = Math.min(canvas.width / image.width, canvas.height / image.height)
    const width = image.width * scale
    const height = image.height * scale
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not prepare the uploaded image. Please try again.')), 'image/png')
    })
  } finally { image.close() }
}

function buildPrompt(mode: AugmentationMode, fabric: FabricType, defect: DefectType) {
  if (mode === 'dataset-builder') {
    return `Photorealistic textile dataset sample of ${fabric.toLowerCase()} fabric with one naturally integrated ${defect.toLowerCase()} defect, preserve the selected fabric identity, source framing, folds, macro details, and lighting, realistic industrial close-up photography, ${defect === 'Hole'
      ? 'irregular woven edge interruption with exposed or darker underlying fibers and visibly broken threads'
      : defect === 'Scratch'
        ? 'thin rubbed fibers and realistic linear abrasion through the surface weave'
        : defect === 'Stain'
          ? 'organic pigment discoloration absorbed naturally into surrounding fibers'
          : defect === 'Tear'
            ? 'irregular pulled fibers and separated weave strands forming a genuine tear'
            : 'realistic visible surface damage'}; no text, label, sticker, painted circle, or artificial overlay.`
  }
  return mode === 'color-variation'
    ? `Photorealistic image-to-image variation of the uploaded textile. Keep the selected fabric type and its material characteristics, while preserving the source framing, folds, lighting, shadows, and fine details.`
    : `Photorealistic macro photograph of the selected ${fabric.toLowerCase()} textile fabric with exactly one naturally integrated ${defect.toLowerCase()} defect, preserve the selected fabric identity and source folds, base pattern, and lighting, realistic industrial textile inspection photography. ${defect === 'Hole'
      ? 'The hole must interrupt the woven structure with irregular broken threads, visible surrounding fraying, and natural depth rather than a black circle or sticker.'
      : defect === 'Scratch'
        ? 'The scratch must visibly abrade and disturb individual surface threads as a thin irregular line rather than a painted mark.'
        : defect === 'Stain'
          ? 'The stain must soak into and discolor the actual fibers with natural uneven edges rather than an artificial solid patch.'
          : defect === 'Tear'
            ? 'The tear must separate the weave with irregular pulled and broken threads rather than a straight cut or painted line.'
            : 'The defect must visibly alter the actual textile surface with natural irregular texture rather than a label or overlay.'} No text, label, logo, sticker, uniform black shape, or completely unrelated fabric.`
}

export default function AugmentationWorkspace({ mode, sdxlStatus, onBack, onGenerated, onSaveImage }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const activeRequest = useRef<AbortController | null>(null)
  const generationSession = useRef(0)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [fabric, setFabric] = useState<FabricType>('Cotton')
  const [defect, setDefect] = useState<DefectType>('Hole')
  const [imageStrength, setImageStrength] = useState(0.3)
  const [variationCount, setVariationCount] = useState('4')
  const [results, setResults] = useState<Result[]>([])
  const [generationPrompts, setGenerationPrompts] = useState<GenerationPrompts | null>(null)
  const [selectedResult, setSelectedResult] = useState<Result | null>(null)
  const [savedUrls, setSavedUrls] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [zipLoading, setZipLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [copiedPrompt, setCopiedPrompt] = useState<'positive' | 'negative' | null>(null)
  const [promptCopyError, setPromptCopyError] = useState('')
  const [dragging, setDragging] = useState(false)

  const title = mode === 'color-variation'
    ? 'Color Variation Generator'
    : mode === 'dataset-builder'
      ? 'Dataset Builder'
      : 'Create Defects on Fabric'
  const prompt = buildPrompt(mode, fabric, defect)
  const requestedVariations = Number(variationCount)
  const validVariationCount = Number.isInteger(requestedVariations) && requestedVariations >= 1 && requestedVariations <= 50
  const canGenerate = !!file && validVariationCount && sdxlStatus === 'configured' && !loading

  useEffect(() => {
    if (!file) { setPreviewUrl(''); return }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const chooseFile = (nextFile?: File) => {
    if (!nextFile) return
    if (!['image/png', 'image/jpeg'].includes(nextFile.type)) {
      setError('Please choose a PNG or JPG image.')
      return
    }
    if (nextFile.size > 15 * 1024 * 1024) {
      setError('That image is larger than 15 MB. Please choose a smaller file.')
      return
    }
    generationSession.current += 1
    activeRequest.current?.abort()
    activeRequest.current = null
    setLoading(false)
    setProgress(0)
    setError('')
    setMessage('')
    setFile(nextFile)
    setResults([])
    setGenerationPrompts(null)
    setSelectedResult(null)
    setSavedUrls([])
    setCopiedPrompt(null)
    setPromptCopyError('')
  }

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    chooseFile(event.target.files?.[0])
    event.target.value = ''
  }
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    chooseFile(event.dataTransfer.files[0])
  }

  const generate = async () => {
    if (!file || !canGenerate) return
    const requestId = ++generationSession.current
    const controller = new AbortController()
    activeRequest.current = controller
    const sourceFile = file
    setLoading(true)
    setProgress(0)
    setError('')
    setMessage('')
    setResults([])
    setGenerationPrompts(null)
    setSelectedResult(null)
    setCopiedPrompt(null)
    setPromptCopyError('')
    try {
      const preparedImage = await prepareImage(sourceFile)
      if (requestId !== generationSession.current) return
      const formData = new FormData()
      formData.append('image', preparedImage, `${sourceFile.name.replace(/\.[^.]+$/, '') || 'image'}.png`)
      formData.append('prompt', prompt)
      formData.append('negativePrompt', mode === 'color-variation'
        ? `${negativePrompt} flat color overlay, color cast, colored lighting, altered weave, changed material`
        : negativePrompt)
      formData.append('imageStrength', String(imageStrength))
      formData.append('variations', String(requestedVariations))
      formData.append('defectType', defect)
      formData.append('taskMode', mode)
      formData.append('fabricType', fabric)

      const progressTimer = window.setInterval(() => setProgress((current) => Math.min(current + 2, 90)), 700)
      try {
        const response = await fetch('/api/stable-diffusion/augment', { method: 'POST', body: formData, signal: controller.signal })
        let payload: unknown
        try { payload = await response.json() }
        catch { throw new Error('The generation server returned an unreadable response.') }
        if (!response.ok) {
          const apiError = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : 'Stable Diffusion generation failed. Please try again.'
          throw new Error(apiError)
        }
        if (!payload || typeof payload !== 'object' ||
            !('images' in payload) || !Array.isArray(payload.images) ||
            !('positivePrompt' in payload) || typeof payload.positivePrompt !== 'string' ||
            !('negativePrompt' in payload) || typeof payload.negativePrompt !== 'string') {
          throw new Error('The generation server returned incomplete image or prompt data.')
        }
        const images = payload.images.filter((image): image is { name: string; dataUrl: string } =>
          !!image && typeof image === 'object' && 'name' in image && typeof image.name === 'string' && 'dataUrl' in image && typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:image/png;base64,'))
        if (!images.length) throw new Error('Stable Diffusion did not return any usable images.')
        if (requestId !== generationSession.current) return
        const generated = images.map(({ name, dataUrl }) => ({ name, url: dataUrl }))
        setResults(generated)
        setGenerationPrompts({ positive: payload.positivePrompt, negative: payload.negativePrompt })
        if (generated.length > 0) setSelectedResult(generated[0])
        setProgress(100)
        const summary = `${generated.length} images · ${fabric} · ${mode === 'color-variation' ? 'Natural color variations' : defect}`
        setMessage(`${generated.length} AI-generated image${generated.length === 1 ? '' : 's'} ready.`)
        onGenerated(summary, generated)
      } finally { window.clearInterval(progressTimer) }
    } catch (reason) {
      if (controller.signal.aborted || requestId !== generationSession.current) return
      setProgress(0)
      setError(reason instanceof TypeError ? 'Could not reach the API. Make sure the backend is running and try again.' : reason instanceof Error ? reason.message : 'Something went wrong while processing this image.')
    } finally {
      if (requestId === generationSession.current) setLoading(false)
      if (activeRequest.current === controller) activeRequest.current = null
    }
  }

  const downloadImage = (image: Result, index: number) => {
    const anchor = document.createElement('a')
    anchor.href = image.url
    const prefix = mode === 'dataset-builder' ? 'fabric_variation' : mode === 'defect-creation' ? `${defect.toLowerCase().replaceAll(' ', '-')}_defect` : 'fabric_variation'
    anchor.download = `${prefix}_${String(index + 1).padStart(2, '0')}.png`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  const downloadAll = async () => {
    if (!results.length || zipLoading) return
    setZipLoading(true)
    setError('')
    try {
      const archive = new JSZip()
      results.forEach((result, index) => {
        const prefix = mode === 'dataset-builder' ? 'fabric_variation' : mode === 'defect-creation' ? `${defect.toLowerCase().replaceAll(' ', '-')}_defect` : 'fabric_variation'
        archive.file(`${prefix}_${String(index + 1).padStart(2, '0')}.png`, result.url.split(',')[1], { base64: true })
      })
      const blob = await archive.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${mode === 'dataset-builder' ? 'fabric_variations' : mode === 'defect-creation' ? `${defect.toLowerCase().replaceAll(' ', '-')}_defects` : 'fabric_variations'}.zip`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (reason) {
      setError(reason instanceof Error ? `Could not create ZIP: ${reason.message}` : 'The ZIP archive could not be created.')
    } finally { setZipLoading(false) }
  }

  const saveImage = (image: Result) => {
    if (savedUrls.includes(image.url)) return
    onSaveImage(image)
    setSavedUrls((current) => [...current, image.url])
  }

  const copyPrompt = async (kind: 'positive' | 'negative', text: string) => {
    setPromptCopyError('')
    try {
      await navigator.clipboard.writeText(text)
      setCopiedPrompt(kind)
    } catch {
      setCopiedPrompt(null)
      setPromptCopyError('Could not copy the prompt. Check clipboard permissions and try again.')
    }
  }

  return <section className="content-page workspace-page">
    <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> Back to Tools</button>
    <div className="page-heading"><span className="eyebrow">{mode === 'dataset-builder' ? 'DATASET GENERATION WORKFLOW' : 'SDXL WORKSPACE'}</span><h1>{title}</h1><p>{mode === 'color-variation'
      ? 'Generate color-focused textile variations using the configured Stability AI image-to-image workflow.'
      : mode === 'dataset-builder'
        ? 'Generate real variations of the uploaded fabric for the selected defect type.'
        : 'Generate synthetic textile defect images using the configured Stability AI image-to-image workflow.'}</p></div>
    <div className="workspace-grid">
      <div className="workspace-controls">
        <section className="workspace-card">
          <div className="card-heading">{mode !== 'dataset-builder' && <span className="step-badge">01</span>}<div><h2>{mode === 'dataset-builder' ? 'Upload Image' : 'Upload fabric image'}</h2><p>PNG or JPEG · up to 15 MB</p></div></div>
          <input ref={fileInput} className="visually-hidden" type="file" accept="image/png,image/jpeg" onChange={handleFile} />
          <div className={`workspace-dropzone ${dragging ? 'workspace-dropzone-active' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={handleDrop} onClick={() => fileInput.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click() }}>
            {previewUrl ? <><img src={previewUrl} alt="Uploaded textile preview" /><span className="upload-file-name">{file?.name}</span></> : <><span className="upload-icon"><Upload size={19} /></span><b>Drop image here or browse</b><small>Choose a textile image to begin.</small></>}
          </div>
          {file && <button className="button button-outline button-full change-image-button" type="button" onClick={() => fileInput.current?.click()}><Upload size={15} /> Re-upload / Change Image</button>}
          {error && <p className="inline-error" role="alert"><CircleHelp size={15} />{error}</p>}
        </section>
        <section className="workspace-card">
          <div className="card-heading">{mode !== 'dataset-builder' && <span className="step-badge">02</span>}<div><h2>{mode === 'dataset-builder' ? 'Image Settings' : 'Image settings'}</h2><p>Set the context for your generation.</p></div></div>
          <div className={`form-grid ${mode === 'color-variation' ? 'form-grid-single' : ''}`}>
            <label>{mode === 'dataset-builder' ? 'Fabric Type' : 'Fabric type'}<select value={fabric} onChange={(event) => setFabric(event.target.value as FabricType)}>{(['Cotton', 'Silk', 'Denim', 'Wool', 'Polyester'] as FabricType[]).map((value) => <option key={value}>{value}</option>)}</select></label>
            {mode !== 'color-variation' && <label>{mode === 'dataset-builder' ? 'Defect Type' : 'Defect type'}<select value={defect} onChange={(event) => setDefect(event.target.value as DefectType)}>{(['Hole', 'Stain', 'Scratch', 'Tear'] as DefectType[]).map((value) => <option key={value}>{value}</option>)}</select></label>}
          </div>
        </section>
        {mode === 'dataset-builder' && <section className="workspace-card">
          <div className="card-heading"><div><h2>AI Generation Controls</h2><p>Strength controls how much the source image changes.</p></div></div>
          <div className="workspace-range-label"><label htmlFor="image-strength">Image strength</label><b>{imageStrength.toFixed(2)}</b></div>
          <input id="image-strength" className="range-input" type="range" min="0.25" max="0.35" step="0.01" value={imageStrength} onChange={(event) => setImageStrength(Number(event.target.value))} />
          <p className="field-note"><b>Lower strength:</b> Original image can undergo more changes.</p>
          <p className="field-note"><b>Higher strength:</b> More original image characteristics are preserved.</p>
        </section>}
        {mode !== 'dataset-builder' && <div className="workspace-control-row"><label htmlFor="variation-count">Number of outputs</label><input id="variation-count" type="number" min="1" max="50" step="1" value={variationCount} onChange={(event) => setVariationCount(event.target.value)} aria-invalid={!validVariationCount} /></div>}
        {mode === 'dataset-builder' && <section className="workspace-card">
          <div className="card-heading"><div><h2>Number of Variations</h2><p>Choose how many actual generated images to return.</p></div></div>
          <div className="workspace-control-row"><label htmlFor="variation-count">Number of variations</label><input id="variation-count" type="number" min="1" max="50" step="1" value={variationCount} onChange={(event) => setVariationCount(event.target.value)} aria-invalid={!validVariationCount} /></div>
        </section>}
        {mode === 'dataset-builder' && <div>
          {!validVariationCount && <p className="field-note field-error">Enter a whole number from 1 to 50.</p>}
        </div>}
        {mode !== 'dataset-builder' && <div>
          {!validVariationCount && <p className="field-note field-error">Enter a whole number from 1 to 50.</p>}
          <div className="workspace-range-label"><label htmlFor="image-strength">Image strength</label><b>{imageStrength.toFixed(2)}</b></div>
          <input id="image-strength" className="range-input" type="range" min="0.25" max="0.35" step="0.01" value={imageStrength} onChange={(event) => setImageStrength(Number(event.target.value))} />
          <p className="field-note">Lower strength: Original image can undergo more changes.<br />Higher strength: More original image characteristics are preserved.</p>
        </div>}
        <section className="workspace-card">
          <div className="card-heading">{mode !== 'dataset-builder' && <span className="step-badge">03</span>}<div><h2>{mode === 'dataset-builder' ? 'Generate' : 'Generate images'}</h2><p>Generation uses the existing Stability AI SDXL integration.</p></div></div>
          {sdxlStatus !== 'configured' && <p className="integration-message" role="status">{sdxlStatus === 'checking' ? 'Checking SDXL configuration…' : sdxlStatus === 'needs-key' ? 'Add STABILITY_API_KEY to backend/.env to enable generation.' : 'The backend status is unavailable. Check that the backend is running.'}</p>}
          {loading && <div className="progress-wrap" role="status" aria-live="polite"><div><span>Generating with SDXL</span><b>{progress}%</b></div><progress value={progress} max="100" /></div>}
          <button className="button button-primary button-full generate-button" disabled={!canGenerate} onClick={generate}>{loading ? <><LoaderCircle size={16} className="spin" /> Generating…</> : <><WandSparkles size={16} /> Generate {variationCount} images</>}</button>
          {message && <p className="success-message"><Check size={14} />{message}</p>}
          {!file && <p className="field-note centered-note">Upload an image to enable generation.</p>}
        </section>
      </div>
      <section className="workspace-card results-card">
        <div className="results-heading"><div className="card-heading">{mode !== 'dataset-builder' && <span className="step-badge">04</span>}<div><h2>Results</h2><p>{results.length ? `${results.length} generated images` : 'Generated images appear here.'}</p></div></div>{results.length > 0 && <button className="button button-outline" onClick={downloadAll} disabled={zipLoading}>{zipLoading ? <LoaderCircle size={14} className="spin" /> : <ArrowDownToLine size={14} />}{zipLoading ? 'Preparing…' : 'Download All as ZIP'}</button>}</div>
        {mode === 'dataset-builder' && generationPrompts && <details className="generation-prompts">
          <summary>View Generation Prompts</summary>
          <div className="generation-prompt">
            <div className="generation-prompt-heading"><b>Positive Prompt</b><button type="button" className="prompt-copy-button" onClick={() => void copyPrompt('positive', generationPrompts.positive)}><Copy size={13} />{copiedPrompt === 'positive' ? 'Copied' : 'Copy Positive Prompt'}</button></div>
            <p>{generationPrompts.positive}</p>
          </div>
          <div className="generation-prompt">
            <div className="generation-prompt-heading"><b>Negative Prompt</b><button type="button" className="prompt-copy-button" onClick={() => void copyPrompt('negative', generationPrompts.negative)}><Copy size={13} />{copiedPrompt === 'negative' ? 'Copied' : 'Copy Negative Prompt'}</button></div>
            <p>{generationPrompts.negative || 'No negative prompt was sent for this generation.'}</p>
          </div>
          {promptCopyError && <p className="inline-error" role="alert">{promptCopyError}</p>}
        </details>}
        {selectedResult && previewUrl && <div className="comparison-grid"><div><span>BEFORE · Original Fabric</span><img src={previewUrl} alt="Original uploaded textile before generation" /></div><div><span>AFTER · {selectedResult.name}</span><img src={selectedResult.url} alt={`Selected generated variation: ${selectedResult.name}`} /></div></div>}
        {results.length ? <div className="result-grid">{results.map((image, index) => <article className={`result-item ${selectedResult?.url === image.url ? 'result-item-selected' : ''}`} key={`${image.name}-${index}`}><button className="result-item-select" type="button" aria-pressed={selectedResult?.url === image.url} onClick={() => setSelectedResult(image)}><img src={image.url} alt={image.name} /><span>{selectedResult?.url === image.url ? 'Selected' : 'Select variation'}</span></button><div className="result-item-actions"><span title={image.name}>{image.name}</span><button aria-label={`Download ${image.name}`} title="Download" onClick={() => downloadImage(image, index)}><ArrowDownToLine size={15} /></button><button aria-label={`Save ${image.name}`} title={savedUrls.includes(image.url) ? 'Saved' : 'Save image'} onClick={() => saveImage(image)} disabled={savedUrls.includes(image.url)}>{savedUrls.includes(image.url) ? <Check size={15} /> : <Bookmark size={15} />}</button></div></article>)}</div> :
          <div className="results-empty"><span className="empty-icon"><FileImage size={21} /></span><b>No results yet</b><p>Upload an image and run the configured SDXL workflow to see output here.</p></div>}
        <p className="workspace-disclaimer">Review generated images before using them. Outputs are produced by SDXL and may not preserve every source detail.</p>
      </section>
    </div>
  </section>
}
