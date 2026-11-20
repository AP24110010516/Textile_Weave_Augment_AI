import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import JSZip from 'jszip'
import { ArrowDownToLine, ArrowRight, Check, CircleHelp, Eye, FileImage, Layers3, LoaderCircle, RotateCcw, Sparkles, Upload, WandSparkles, X } from 'lucide-react'

type Result = { name: string; url: string }
type VariationOption = '3' | '5' | '10' | '15' | '20' | 'custom'
type FabricType = 'Cotton' | 'Silk' | 'Denim' | 'Polyester' | 'Other'
type DefectType = 'Hole' | 'Stain' | 'Scratch' | 'Tear' | 'Other'

const variationOptions: VariationOption[] = ['3', '5', '10', '15', '20', 'custom']
const negativePrompt = 'cartoon, illustration, artificial texture, plastic material, unrealistic fabric, excessive blur, distorted weave, text, watermark, visual artifacts.'
const supportedImageDimensions = [
  { width: 1024, height: 1024 },
  { width: 1152, height: 896 },
  { width: 1216, height: 832 },
  { width: 1344, height: 768 },
  { width: 1536, height: 640 },
  { width: 640, height: 1536 },
  { width: 768, height: 1344 },
  { width: 832, height: 1216 },
  { width: 896, height: 1152 },
]

async function prepareImageForStability(file: File): Promise<Blob> {
  let image: ImageBitmap
  try {
    image = await createImageBitmap(file)
  } catch {
    throw new Error('Could not read the uploaded image. Please try a different PNG or JPG file.')
  }

  try {
    const aspectRatio = image.width / image.height
    const dimensions = supportedImageDimensions.reduce((closest, candidate) =>
      Math.abs(Math.log(aspectRatio / (candidate.width / candidate.height))) <
        Math.abs(Math.log(aspectRatio / (closest.width / closest.height)))
        ? candidate
        : closest,
    )
    const canvas = document.createElement('canvas')
    canvas.width = dimensions.width
    canvas.height = dimensions.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not prepare the uploaded image. Please try again.')

    const scale = Math.min(canvas.width / image.width, canvas.height / image.height)
    const width = image.width * scale
    const height = image.height * scale
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Could not prepare the uploaded image. Please try again.'))
      }, 'image/png')
    })
  } finally {
    image.close()
  }
}

function buildTextilePrompt(fabricType: FabricType, defectType: DefectType): string {
  return `Photorealistic macro photograph of ${fabricType.toLowerCase()} textile fabric with a visible ${defectType.toLowerCase()} defect, realistic woven fibers, natural textile texture, detailed fabric surface, industrial textile inspection photography, realistic lighting, high-quality textile details, preserved fabric structure, defect appearance clear and realistic.`
}

function App() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [imageStrength, setImageStrength] = useState(0.3)
  const [results, setResults] = useState<Result[]>([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [zipLoading, setZipLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [variationOption, setVariationOption] = useState<VariationOption>('5')
  const [customCount, setCustomCount] = useState('10')
  const [fabricType, setFabricType] = useState<FabricType>('Cotton')
  const [defectType, setDefectType] = useState<DefectType>('Hole')
  const [comparePosition, setComparePosition] = useState(50)

  const customCountValue = /^\d+$/.test(customCount) ? Number(customCount) : 0
  const customCountError = variationOption === 'custom' && (customCountValue < 1 || customCountValue > 50) ? 'Choose a whole number between 1 and 50.' : ''
  const variationCount = variationOption === 'custom' ? customCountValue : Number(variationOption)
  const canGenerate = !!file && !customCountError && variationCount > 0 && !loading

  useEffect(() => {
    if (!file) {
      setPreviewUrl('')
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const acceptFile = (nextFile?: File) => {
    setError('')
    setMessage('')
    if (!nextFile) return
    if (!['image/png', 'image/jpeg'].includes(nextFile.type)) {
      setError('Please choose a PNG or JPG image.')
      return
    }
    if (nextFile.size > 15 * 1024 * 1024) {
      setError('That image is larger than 15 MB. Please choose a smaller file.')
      return
    }
    setFile(nextFile)
    setResults([])
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => acceptFile(event.target.files?.[0])
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setDragging(false); acceptFile(event.dataTransfer.files[0])
  }

  const generate = async () => {
    if (!file || !canGenerate) return
    setLoading(true); setProgress(0); setError(''); setMessage('')
    try {
      const preparedImage = await prepareImageForStability(file)
      const formData = new FormData();
      formData.append('image', preparedImage, `${file.name.replace(/\.[^.]+$/, '') || 'image'}.png`)
      formData.append('prompt', buildTextilePrompt(fabricType, defectType))
      formData.append('negativePrompt', negativePrompt)
      formData.append('imageStrength', String(imageStrength))
      formData.append('variations', String(variationCount))

      const progressTimer = window.setInterval(() => setProgress((current) => Math.min(current + 2, 90)), 700)
      try {
        const response = await fetch('/api/stable-diffusion/augment', { method: 'POST', body: formData })
        let payload: unknown
        try { payload = await response.json() } catch { throw new Error('The generation server returned an unreadable response.') }
        if (!response.ok) {
          const apiError = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : 'Stable Diffusion generation failed. Please try again.'
          throw new Error(apiError)
        }
        if (!payload || typeof payload !== 'object' || !('images' in payload) || !Array.isArray(payload.images)) {
          throw new Error('The generation server returned no images.')
        }
        const images = payload.images.filter((image): image is { name: string; dataUrl: string } => !!image && typeof image === 'object' && 'name' in image && typeof image.name === 'string' && 'dataUrl' in image && typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:image/png;base64,'))
        if (images.length === 0) throw new Error('Stable Diffusion did not return any usable images.')
        setResults(images.map(({ name, dataUrl }) => ({ name, url: dataUrl })))
        setProgress(100); setComparePosition(50); setMessage(`${images.length} AI-generated image${images.length === 1 ? '' : 's'} are ready to explore.`)
      } finally { window.clearInterval(progressTimer) }
    } catch (reason) {
      setProgress(0)
      setError(reason instanceof TypeError ? 'Could not reach the API. Make sure the backend is running and try again.' : reason instanceof Error ? reason.message : 'Something went wrong while processing this image.')
    } finally {
      setLoading(false)
    }
  }

  const downloadImage = (url: string, name: string) => {
    const link = document.createElement('a'); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove()
  }

  const downloadAll = async () => {
    if (!results.length || zipLoading) return
    setZipLoading(true); setError('')
    try {
      const archive = new JSZip()
      results.forEach((result, index) => archive.file(`weaveaugment-variation-${String(index + 1).padStart(2, '0')}.png`, result.url.split(',')[1], { base64: true }))
      const blob = await archive.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      downloadImage(url, 'weaveaugment-variations.zip')
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The ZIP archive could not be created.') }
    finally { setZipLoading(false) }
  }

  return (
    <div className="min-h-screen bg-[#faf9fe] text-[#2a243d]">
      <header className="fixed inset-x-0 top-0 z-30 border-b border-[#eceaf3] bg-white/90 backdrop-blur-xl">
        <div className="page-shell flex h-[72px] items-center justify-between">
          <a href="#home" className="flex items-center gap-2.5"><span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-[#8063ee] to-[#477ee7] text-white shadow-md shadow-violet-200"><Layers3 size={19} /></span><span className="font-display text-[17px] font-extrabold tracking-[-.7px] text-[#282440]">weave<span className="text-[#775ce4]">augment</span></span><span className="rounded-md bg-[#f0edff] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.12em] text-[#7357df]">AI</span></a>
          <nav className="hidden items-center gap-8 text-[13px] font-medium text-[#716f81] md:flex"><a href="#home" className="transition hover:text-[#795ce8]">Home</a><a href="#augment" className="transition hover:text-[#795ce8]">Augmentation</a><a href="#how-it-works" className="transition hover:text-[#795ce8]">How it works</a><a href="#about" className="transition hover:text-[#795ce8]">About</a></nav>
          <a href="#upload" className="hidden items-center gap-2 rounded-xl bg-[#765be4] px-4 py-2.5 text-[13px] font-bold text-white shadow-lg shadow-violet-200 transition hover:-translate-y-0.5 hover:bg-[#684bd7] md:flex">Get started <ArrowRight size={15} /></a>
          <button aria-label="Toggle navigation" className="rounded-lg p-2 text-[#39364f] md:hidden" onClick={() => setMobileMenu(!mobileMenu)}>{mobileMenu ? <X size={21} /> : <Layers3 size={21} />}</button>
        </div>
        <AnimatePresence>{mobileMenu && <motion.nav initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-t border-[#eeedf4] bg-white md:hidden"><div className="page-shell grid gap-1 py-3 text-sm text-[#716f81]">{[['Home', '#home'], ['Augmentation', '#augment'], ['How it works', '#how-it-works'], ['About', '#about']].map(([label, href]) => <a key={href} className="rounded-lg px-2 py-2 hover:bg-[#f7f5ff]" href={href} onClick={() => setMobileMenu(false)}>{label}</a>)}</div></motion.nav>}</AnimatePresence>
      </header>

      <main className="page-shell py-28">
        <section id="home" className="grid gap-8 pb-10 pt-6 md:grid-cols-2 md:items-center">
          <div>
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#e5defc] bg-white px-3 py-1.5 text-[11px] font-bold tracking-wide text-[#7259dc] shadow-sm"><Sparkles size={13} /> A little more variety. A lot more confidence.</div>
            <h1 className="font-display max-w-[620px] text-[42px] font-extrabold leading-[1.1] tracking-[-2.2px] text-[#25223b] sm:text-[55px]">Smarter fabric inspection <span className="gradient-text">starts here.</span></h1>
            <p className="mt-5 max-w-[500px] text-[15px] leading-7 text-[#777487]">Upload a textile image and let Stable Diffusion XL generate realistic inspection variations while preserving the original defect context.</p>
            <div className="mt-8 flex flex-wrap items-center gap-4"><a href="#upload" className="group inline-flex items-center gap-2.5 rounded-xl bg-gradient-to-r from-[#795de8] to-[#5588eb] px-5 py-3.5 text-[13px] font-bold text-white shadow-xl shadow-violet-200/70 transition hover:-translate-y-0.5 hover:shadow-violet-300"><WandSparkles size={17} /> Start augmenting <ArrowRight className="transition group-hover:translate-x-1" size={15} /></a><a href="#how-it-works" className="inline-flex items-center gap-2 px-2 py-3 text-[13px] font-semibold text-[#716e82] hover:text-[#7559e3]"><Eye size={16} /> See how it works</a></div>
          </div>
          <div className="relative mx-auto w-full max-w-[510px]">
            <div className="relative h-[340px] overflow-hidden rounded-[30px] border-[7px] border-white bg-[#ebe6ff] shadow-[0_35px_80px_-28px_rgba(80,61,140,.34)]">
              <div className="fabric-texture absolute inset-0" /><div className="noise absolute inset-0 opacity-30 mix-blend-soft-light" /><div className="absolute inset-0 bg-gradient-to-tr from-[#784fe5]/25 via-transparent to-[#ffe1ca]/35" /><div className="absolute inset-0 soft-grid opacity-20" /><div className="absolute left-[37%] top-[35%] size-[86px] rounded-full border-2 border-dashed border-white/90 shadow-[0_0_24px_rgba(255,255,255,.9)] sm:size-[106px]" /><div className="absolute left-[46%] top-[43%] size-3 rounded-full bg-[#fff] shadow-[0_0_18px_8px_rgba(255,255,255,.72)]" /><div className="absolute bottom-4 left-4 right-4 flex items-center justify-between rounded-2xl border border-white/70 bg-white/80 p-3.5 backdrop-blur-md"><div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl bg-[#f0eaff] text-[#795ce8]"><FileImage size={17} /></span><span><b className="block text-[11px] text-[#39354f]">fabric_sample_01</b><i className="text-[9px] not-italic text-[#9692a5]">Cotton · weave detail</i></span></div><span className="rounded-lg bg-[#e6f8f1] px-2 py-1 text-[9px] font-bold text-[#3cae85]">READY</span></div>
            </div>
          </div>
        </section>

        <section id="augment" className="grid gap-5 py-6 lg:grid-cols-[.9fr_1.1fr]">
          <div className="grid gap-5">
            <div id="upload" className="rounded-[22px] border border-[#eceaf3] bg-white p-5 shadow-[0_8px_30px_-20px_rgba(45,34,90,.18)]">
              <div className="mb-4 flex items-center justify-between"><div><h3 className="text-[14px] font-bold text-[#353149]">01 <span className="ml-1.5">Upload image</span></h3><p className="mt-1 text-[11px] text-[#9290a1]">Choose a fabric or defect image to begin.</p></div><span className="grid size-9 place-items-center rounded-xl bg-[#f2efff] text-[#795ce8]"><Upload size={17} /></span></div>
              <input ref={fileInput} className="hidden" type="file" accept="image/png,image/jpeg" onChange={handleFileChange} />
              <div onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={handleDrop} onClick={() => fileInput.current?.click()} className={`group relative flex min-h-[178px] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed transition ${dragging ? 'border-[#785de8] bg-[#f5f2ff]' : 'border-[#dcd9e8] bg-[#fbfaff] hover:border-[#9b87ef] hover:bg-[#f8f6ff]'}`}>
                {previewUrl ? <><img src={previewUrl} alt="Uploaded fabric preview" className="absolute inset-0 h-full w-full object-contain p-2" /><span className="absolute bottom-2 right-2 rounded-lg bg-white/95 px-2.5 py-1.5 text-[10px] font-semibold text-[#635a83] shadow">{file?.name} · Change image</span></> : <><span className="mb-3 grid size-11 place-items-center rounded-2xl bg-white text-[#795ce8] shadow-sm transition group-hover:-translate-y-1"><Upload size={19} /></span><span className="text-[12px] font-semibold text-[#4c4960]">Drop your image here</span><span className="mt-1 text-[10px] text-[#9693a5]">or click to browse · PNG, JPG up to 15 MB</span></>}
              </div>
              <AnimatePresence>{error && <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-3 flex items-start gap-1.5 text-[11px] text-[#d44d69]"><CircleHelp size={13} className="mt-0.5 shrink-0" />{error}</motion.p>}</AnimatePresence>
            </div>

            <div className="rounded-[22px] border border-[#eceaf3] bg-white p-5 shadow-[0_8px_30px_-20px_rgba(45,34,90,.18)]">
              <div className="mb-4"><h3 className="text-[14px] font-bold text-[#353149]">Textile sample details</h3><p className="mt-1 text-[11px] text-[#9290a1]">Add context to your AI-generated inspection examples.</p></div>
              <div className="grid grid-cols-2 gap-3"><label className="text-[10px] font-semibold text-[#777386]">Fabric type<select value={fabricType} onChange={(event) => { setFabricType(event.target.value as FabricType); setResults([]); setMessage('') }} className="mt-1.5 w-full rounded-xl border border-[#eeedf4] bg-[#fcfbfe] px-3 py-2.5 text-[11px] text-[#504d62] outline-none focus:border-[#b6a8ef]">{(['Cotton', 'Silk', 'Denim', 'Polyester', 'Other'] as FabricType[]).map((value) => <option key={value}>{value}</option>)}</select></label><label className="text-[10px] font-semibold text-[#777386]">Defect type<select value={defectType} onChange={(event) => { setDefectType(event.target.value as DefectType); setResults([]); setMessage('') }} className="mt-1.5 w-full rounded-xl border border-[#eeedf4] bg-[#fcfbfe] px-3 py-2.5 text-[11px] text-[#504d62] outline-none focus:border-[#b6a8ef]">{(['Hole', 'Stain', 'Scratch', 'Tear', 'Other'] as DefectType[]).map((value) => <option key={value}>{value}</option>)}</select></label></div>
            </div>

            <div className="rounded-[22px] border border-[#eceaf3] bg-white p-5 shadow-[0_8px_30px_-20px_rgba(45,34,90,.18)]">
              <div className="mb-4"><h3 className="text-[14px] font-bold text-[#353149]">AI generation controls</h3><p className="mt-1 text-[11px] text-[#9290a1]">Tune the output while preserving the source textile structure.</p></div>
              <label className="flex items-center justify-between text-[10px] font-semibold text-[#777386]" htmlFor="image-strength"><span>Image strength</span><span className="rounded-md bg-[#f6f4fb] px-1.5 py-0.5 font-bold tabular-nums text-[#7b69bb]">{imageStrength.toFixed(2)}</span></label>
              <input id="image-strength" type="range" min="0.25" max="0.35" step="0.01" value={imageStrength} onChange={(event) => { setImageStrength(Number(event.target.value)); setResults([]); setMessage('') }} className="range-input mt-2 h-1 w-full cursor-pointer appearance-none rounded-full bg-[#e8e5f0]" />
              <p className="mt-1 text-[9px] leading-4 text-[#9693a5]">Lower values allow more changes; higher values preserve more of the upload. Review each generation carefully before using it.</p>
              <details className="mt-4 rounded-xl bg-[#fcfbfe] p-3"><summary className="cursor-pointer text-[10px] font-semibold text-[#777386]">View generated prompts</summary><p className="mt-2 text-[9px] leading-4 text-[#777386]">{buildTextilePrompt(fabricType, defectType)}</p><p className="mt-2 text-[9px] leading-4 text-[#9693a5]"><b>Negative:</b> {negativePrompt}</p></details>
            </div>

            <div className="rounded-[22px] border border-[#eceaf3] bg-white p-5 shadow-[0_8px_30px_-20px_rgba(45,34,90,.18)]">
              <div className="mb-4 flex items-start justify-between gap-3"><div><h3 className="text-[14px] font-bold text-[#353149]">How many variations do you need?</h3><p className="mt-1 text-[11px] text-[#9290a1]">Choose the size of your augmented image set.</p></div><span className="shrink-0 rounded-lg bg-[#f1edff] px-2 py-1 text-[10px] font-bold text-[#7359dd]">{variationCount > 0 && !customCountError ? variationCount : '—'} selected</span></div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">{variationOptions.map((option) => <button key={option} onClick={() => { setVariationOption(option); setResults([]); setMessage('') }} aria-pressed={variationOption === option} className={`rounded-xl border px-2 py-2.5 text-[10px] font-bold transition ${variationOption === option ? 'border-[#9c86ed] bg-[#f3efff] text-[#7055dd] shadow-sm' : 'border-[#eeedf4] bg-white text-[#797689] hover:bg-[#faf9ff]'}`}>{option === 'custom' ? 'Custom' : option}</button>)}</div>
              {variationOption === 'custom' && <label className="mt-3 block text-[10px] font-semibold text-[#777386]">Enter a number from 1 to 50<input type="number" min="1" max="50" step="1" value={customCount} onChange={(event) => { setCustomCount(event.target.value); setResults([]); setMessage('') }} aria-invalid={!!customCountError} className="mt-1.5 w-full rounded-xl border border-[#eeedf4] bg-[#fcfbfe] px-3 py-2.5 text-[11px] text-[#504d62] outline-none focus:border-[#b6a8ef] aria-[invalid=true]:border-[#e8a3b2]" />{customCountError && <span className="mt-1 block text-[10px] font-medium text-[#d44d69]">{customCountError}</span>}</label>}
            </div>
            {loading && <div className="mb-2" role="status" aria-live="polite"><div className="mb-1.5 flex justify-between text-[10px] font-semibold text-[#777386]"><span>Generating with Stable Diffusion XL…</span><span>{progress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#eeeaf8]"><motion.div className="h-full rounded-full bg-gradient-to-r from-[#795ce8] to-[#55a9e3]" animate={{ width: `${progress}%` }} transition={{ duration: .15 }} /></div></div>}
            <button disabled={!canGenerate} onClick={generate} className="group flex w-full items-center justify-center gap-2.5 rounded-xl bg-gradient-to-r from-[#795ce8] via-[#7166e9] to-[#488ee8] px-5 py-3.5 text-[13px] font-bold text-white shadow-lg shadow-violet-200 transition hover:-translate-y-0.5 hover:shadow-violet-300 disabled:cursor-not-allowed disabled:opacity-45">{loading ? <><LoaderCircle size={17} className="animate-spin" /> Generating SDXL images…</> : <><Sparkles size={16} /> Generate {!customCountError && variationCount > 0 ? variationCount : '—'} images <ArrowRight className="transition group-hover:translate-x-1" size={15} /></>}</button>
            {!file && <p className="mt-2 text-center text-[10px] text-[#9693a5]">Upload an image to enable generation.</p>}
            <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-[#eeedf4] bg-[#fcfbfe] px-3 py-2 text-[10px] text-[#615d71]"><span className="font-semibold">Prompt focus</span><span className="rounded-full bg-[#f1edff] px-2 py-1 font-bold text-[#7055dd]">{fabricType} / {defectType}</span></div>
          </div>

          <div className="rounded-[22px] border border-[#eceaf3] bg-white p-5 shadow-[0_8px_30px_-20px_rgba(45,34,90,.18)]">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-[14px] font-bold text-[#353149]">02 <span className="ml-1.5">Your results</span>{results.length > 0 && <span className="ml-2 rounded-full bg-[#f1edff] px-2 py-1 text-[9px] font-bold text-[#7055dd]">{results.length} images</span>}</h3><p className="mt-1 text-[11px] text-[#9290a1]">Original and generated outputs. Review and download as needed.</p></div>{results.length > 0 && <button disabled={zipLoading} onClick={downloadAll} className="inline-flex items-center gap-1.5 rounded-lg border border-[#e9e5f3] px-2.5 py-2 text-[10px] font-bold text-[#71658f] transition hover:border-[#cfc2f3] hover:bg-[#f8f6ff] disabled:opacity-60">{zipLoading ? <LoaderCircle className="animate-spin" size={13} /> : <ArrowDownToLine size={13} />} {zipLoading ? 'Preparing ZIP…' : 'Download all · ZIP'}</button>}</div>
            {previewUrl && <div className="mb-4 grid grid-cols-2 gap-3">{[{ label: 'ORIGINAL', url: previewUrl }, ...(results.length ? [{ label: 'AI OUTPUT', url: results[0].url }] : [])].map((item) => <div key={item.label}><div className="mb-1.5 flex items-center gap-1.5 text-[9px] font-extrabold tracking-[.08em] text-[#817e90]"><span className={`size-1.5 rounded-full ${item.label === 'ORIGINAL' ? 'bg-[#a9a5b6]' : 'bg-[#7a61e7]'}`} />{item.label}</div><div className="checkerboard grid h-[130px] place-items-center overflow-hidden rounded-xl border border-[#efedf4] sm:h-[165px]"><img src={item.url} alt={item.label.toLowerCase()} className="max-h-full max-w-full object-contain" /></div></div>)}</div>}
            {results.length > 0 && previewUrl && <div className="mb-5"><div className="mb-1.5 flex items-center justify-between text-[9px] font-bold text-[#817e90]"><span>BEFORE & AFTER COMPARISON</span><span>Drag to compare</span></div><div className="checkerboard relative h-[185px] overflow-hidden rounded-xl border border-[#efedf4] sm:h-[230px]"><img src={previewUrl} alt="Original image comparison" className="absolute inset-0 h-full w-full object-contain" /><div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - comparePosition}% 0 0)` }}><img src={results[0].url} alt="Augmented image comparison" className="absolute inset-0 h-full w-full object-contain" /></div><span className="absolute left-2 top-2 rounded-md bg-white/90 px-2 py-1 text-[8px] font-bold text-[#625d75]">AFTER</span><span className="absolute right-2 top-2 rounded-md bg-white/90 px-2 py-1 text-[8px] font-bold text-[#625d75]">BEFORE</span><span className="pointer-events-none absolute bottom-0 top-0 w-0.5 bg-white shadow" style={{ left: `${comparePosition}%` }} /><input type="range" min="0" max="100" value={comparePosition} aria-label="Before and after comparison position" onChange={(event) => setComparePosition(Number(event.target.value))} className="absolute inset-x-0 bottom-0 h-8 w-full cursor-ew-resize appearance-none bg-transparent opacity-0" /></div><input type="range" min="0" max="100" value={comparePosition} aria-label="Adjust before and after comparison" onChange={(event) => setComparePosition(Number(event.target.value))} className="range-input mt-2 h-1 w-full cursor-ew-resize appearance-none rounded-full bg-[#e8e5f0]" /></div>}
            {results.length > 0 && <div className="mb-4 rounded-xl border border-[#eeedf4] bg-[#fcfbfe] p-3"><p className="mb-2 text-[9px] font-extrabold uppercase tracking-[.1em] text-[#8a8699]">Generation summary</p><div className="flex flex-wrap gap-1.5">{['Stable Diffusion XL', `Strength ${imageStrength.toFixed(2)}`, fabricType, defectType, `${results.length} images`].map((item) => <span key={item} className="rounded-full bg-white px-2 py-1 text-[9px] font-semibold text-[#6b667e] shadow-sm">{item}</span>)}</div></div>}
            {results.length > 0 ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">{results.map((result, index) => <motion.div key={result.name} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .1 }} className="group min-w-0 overflow-hidden rounded-xl border border-[#efedf4] bg-[#fcfbfe]"><div className="checkerboard relative grid h-[105px] place-items-center overflow-hidden sm:h-[140px]"><img src={result.url} alt={result.name} className="max-h-full max-w-full object-contain transition duration-300 group-hover:scale-105" /><button aria-label={`Download ${result.name}`} onClick={() => downloadImage(result.url, `weaveaugment-${index + 1}.png`)} className="absolute bottom-1.5 right-1.5 grid size-7 place-items-center rounded-lg bg-white text-[#6d5bd0] opacity-0 shadow transition group-hover:opacity-100 focus:opacity-100"><ArrowDownToLine size={14} /></button></div><div className="flex items-center justify-between gap-1 px-2 py-2"><span className="truncate text-[9px] font-bold text-[#59566c]">{result.name}</span><button aria-label={`Download ${result.name}`} onClick={() => downloadImage(result.url, `weaveaugment-${index + 1}.png`)} className="text-[#8b85a2] hover:text-[#7257df]"><ArrowDownToLine size={13} /></button></div></motion.div>)}</div> : <div className={`flex min-h-[235px] flex-col items-center justify-center rounded-2xl border border-dashed border-[#e5e2ed] bg-[#fcfbfe] ${previewUrl ? 'py-8' : 'py-12'}`}>{!previewUrl ? <><span className="relative mb-4 grid size-[66px] place-items-center rounded-[22px] bg-[#f1edff] text-[#8066e9]"><Layers3 size={25} /><i className="absolute -right-1 -top-1 size-4 rounded-full border-2 border-white bg-[#f2c6de]" /></span><p className="text-[12px] font-bold text-[#59566c]">Your gallery is ready</p><p className="mt-1 max-w-[220px] text-center text-[10px] leading-5 text-[#9693a5]">Upload a textile image, set the fabric and defect, and your SDXL variations will appear here.</p><span className="mt-4 flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-[9px] font-semibold text-[#8a8699] shadow-sm"><ArrowDownToLine size={11} /> Your results, right here</span></> : <><span className="grid size-12 place-items-center rounded-2xl bg-[#f1edff] text-[#8066e9]"><Sparkles size={20} /></span><p className="mt-3 text-[11px] font-bold text-[#59566c]">Ready when you are</p><p className="mt-1 max-w-[220px] text-center text-[10px] leading-5 text-[#9693a5]">Adjust the generation settings, then generate your AI variations.</p></>}</div> }
            <AnimatePresence>{message && <motion.p initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="mt-3 flex items-center gap-1.5 text-[10px] font-semibold text-[#37a783]"><Check size={13} />{message}</motion.p>}</AnimatePresence>
            {results.length > 0 && <p className="mt-3 text-[9px] leading-4 text-[#9b98a8]">Generated by Stability AI SDXL. Results may vary; visually inspect them and use the best variations for your textile review workflow.</p>}
          </div>
        </section>

        <section id="how-it-works" className="py-16">
          <div className="mx-auto mb-10 max-w-[520px] text-center"><p className="mb-2 text-[10px] font-extrabold uppercase tracking-[.18em] text-[#8369e8]">A SIMPLE WORKFLOW</p><h2 className="font-display text-[28px] font-extrabold tracking-[-1px] text-[#29263f] sm:text-[34px]">Three steps. Fresh perspective.</h2><p className="mt-2 text-[13px] leading-6 text-[#838093]">No complicated setup. Just your image, a few settings, and AI-generated textile variations to review.</p></div>
          <div className="grid gap-4 md:grid-cols-3">{[{ icon: '☼', title: 'Real textile detail', text: 'Keep woven structure and defect character visible in each generated variation.', tone: 'bg-[#fff0e7] text-[#ed8c45]' }, { icon: '▦', title: 'Defect-aware generation', text: 'Use the selected fabric and defect type to drive a more relevant SDXL prompt.', tone: 'bg-[#e9e4ff] text-[#795ce8]' }, { icon: '✳', title: 'Inspection quality', text: 'Generate variations that are useful for visual checks and dataset review.', tone: 'bg-[#e1f8f4] text-[#38a891]' }].map((feature, index) => <motion.div key={feature.title} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .1 }} className="rounded-[22px] border border-[#eceaf3] bg-white p-5 shadow-[0_8px_30px_-20px_rgba(45,34,90,.16)]"><span className={`grid size-11 place-items-center rounded-2xl text-[18px] ${feature.tone}`}>{feature.icon}</span><h3 className="mt-4 text-[15px] font-bold text-[#2d2942]">{feature.title}</h3><p className="mt-2 text-[12px] leading-6 text-[#6f6b7d]">{feature.text}</p></motion.div>)}</div>
        </section>

        <section id="about" className="py-10">
          <div className="rounded-[28px] border border-[#eceaf3] bg-[#faf8ff] p-6 shadow-[0_10px_30px_-20px_rgba(52,39,104,.15)] md:p-8"><div className="grid gap-6 md:grid-cols-[1.2fr_.8fr] md:items-center"><div><p className="mb-2 text-[10px] font-extrabold uppercase tracking-[.18em] text-[#8369e8]">ABOUT WEAVEAUGMENT</p><h2 className="font-display text-[28px] font-extrabold tracking-[-1px] text-[#29263f] sm:text-[32px]">Built for textile teams that need better visual variety.</h2><p className="mt-3 text-[13px] leading-7 text-[#69657b]">WeaveAugment AI helps teams review fabric defects and generate image variations without a cluttered manual editing workflow. The process stays focused on your textile review needs and delivers generated outputs in a clear, easy-to-check gallery.</p></div><div className="rounded-[22px] border border-[#e8e2fb] bg-white p-4 shadow-sm"><div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#8a859d]">Status</p><b className="mt-1 block text-[18px] text-[#2d2942]">Stable Diffusion XL</b></div><span className="grid size-10 place-items-center rounded-xl bg-[#f0ebff] text-[#7259dd]"><Sparkles size={18} /></span></div><div className="mt-4 space-y-3 text-[11px] text-[#6b667d]"><div className="flex items-center justify-between rounded-xl bg-[#faf9ff] px-3 py-2"><span>Image-to-image</span><span className="font-bold text-[#3aa883]">Ready</span></div><div className="flex items-center justify-between rounded-xl bg-[#faf9ff] px-3 py-2"><span>Fabric focus</span><span className="font-bold text-[#7055dd]">Enabled</span></div><div className="flex items-center justify-between rounded-xl bg-[#faf9ff] px-3 py-2"><span>Download set</span><span className="font-bold text-[#7055dd]">ZIP + PNG</span></div></div></div></div></div>
        </section>

        <footer className="border-t border-[#eceaf3] bg-[#ffffff]">
          <div className="page-shell flex flex-col gap-3 py-6 text-[11px] text-[#7f7b8e] md:flex-row md:items-center md:justify-between"><p>© 2025 WeaveAugment AI</p><div className="flex items-center gap-4"><span className="inline-flex items-center gap-1.5"><Sparkles size={12} /> SDXL image augmentation</span><span className="inline-flex items-center gap-1.5"><RotateCcw size={12} /> generate and review</span></div></div>
        </footer>
      </main>
    </div>
  )
}

export default App
