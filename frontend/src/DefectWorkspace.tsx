import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { ArrowDownToLine, ArrowLeft, Bookmark, Check, CircleHelp, LoaderCircle, ScanSearch, Upload, WandSparkles } from 'lucide-react'

type Mode = 'detection' | 'removal'
type Detection = {
  id: string
  label: string
  confidence: number
  bbox: { x: number; y: number; width: number; height: number }
}
type DetectionResult = {
  detections: Detection[]
  imageWidth: number
  imageHeight: number
}

type Props = {
  mode: Mode
  title: string
  onBack: () => void
  onSaveImage?: (image: { name: string; url: string }) => void
  onGenerated?: (summary: string, images: Array<{ name: string; url: string }>) => void
}

function readDetectionResult(value: unknown): DetectionResult {
  if (!value || typeof value !== 'object' ||
      !('detections' in value) || !Array.isArray(value.detections) ||
      !('imageWidth' in value) || typeof value.imageWidth !== 'number' ||
      !('imageHeight' in value) || typeof value.imageHeight !== 'number') {
    throw new Error('The defect service returned an invalid response.')
  }
  const detections = value.detections.map((item): Detection => {
    if (!item || typeof item !== 'object' ||
        !('id' in item) || typeof item.id !== 'string' ||
        !('label' in item) || typeof item.label !== 'string' ||
        !('confidence' in item) || typeof item.confidence !== 'number' ||
        !('bbox' in item) || !item.bbox || typeof item.bbox !== 'object' ||
        !('x' in item.bbox) || typeof item.bbox.x !== 'number' ||
        !('y' in item.bbox) || typeof item.bbox.y !== 'number' ||
        !('width' in item.bbox) || typeof item.bbox.width !== 'number' ||
        !('height' in item.bbox) || typeof item.bbox.height !== 'number') {
      throw new Error('The defect service returned an invalid detection.')
    }
    return {
      id: item.id,
      label: item.label,
      confidence: item.confidence,
      bbox: { x: item.bbox.x, y: item.bbox.y, width: item.bbox.width, height: item.bbox.height },
    }
  })
  return { detections, imageWidth: value.imageWidth, imageHeight: value.imageHeight }
}

function apiError(payload: unknown, fallback: string) {
  return payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
    ? payload.error
    : fallback
}

function downloadDataUrl(url: string, filename: string) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export default function DefectWorkspace({ mode, title, onBack, onSaveImage, onGenerated }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const activeRequest = useRef<AbortController | null>(null)
  const requestId = useRef(0)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [result, setResult] = useState<DetectionResult | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [correctedUrl, setCorrectedUrl] = useState('')
  const [phase, setPhase] = useState<'idle' | 'detecting' | 'removing'>('idle')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!file) {
      setPreviewUrl('')
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => () => {
    requestId.current += 1
    activeRequest.current?.abort()
  }, [])

  const analyze = async (source: File) => {
    const currentRequest = ++requestId.current
    const controller = new AbortController()
    activeRequest.current = controller
    setPhase('detecting')
    setError('')
    setResult(null)
    setSelectedIds([])
    setCorrectedUrl('')
    try {
      const formData = new FormData()
      formData.append('image', source, source.name)
      const response = await fetch('/api/defects/detect', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      })
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok) throw new Error(apiError(payload, 'Fabric analysis failed. Please try again.'))
      const detected = readDetectionResult(payload)
      if (currentRequest !== requestId.current) return
      setResult(detected)
      if (mode === 'removal') setSelectedIds(detected.detections.slice(0, 12).map(({ id }) => id))
      if (mode === 'detection' && onGenerated && detected.detections.length > 0) {
        onGenerated(`Detected ${detected.detections.length} defect${detected.detections.length === 1 ? '' : 's'} on fabric`, [])
      }
    } catch (reason) {
      if (controller.signal.aborted || currentRequest !== requestId.current) return
      setError(reason instanceof TypeError
        ? 'Could not reach the model service. Check that the backend is running.'
        : reason instanceof Error ? reason.message : 'Fabric analysis failed. Please try again.')
    } finally {
      if (currentRequest === requestId.current) setPhase('idle')
      if (activeRequest.current === controller) activeRequest.current = null
    }
  }

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
    requestId.current += 1
    activeRequest.current?.abort()
    activeRequest.current = null
    setFile(nextFile)
    setResult(null)
    setSelectedIds([])
    setCorrectedUrl('')
    setSaved(false)
    setPhase('idle')
    setError('')
    void analyze(nextFile)
  }

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    chooseFile(event.target.files?.[0])
    event.target.value = ''
  }

  const toggleDetection = (id: string, checked: boolean) => {
    setError('')
    setSelectedIds((current) => {
      if (!checked) return current.filter((value) => value !== id)
      if (current.length >= 12) {
        setError('Select no more than 12 defects per inpainting request.')
        return current
      }
      return current.includes(id) ? current : [...current, id]
    })
  }

  const removeSelected = async () => {
    if (!file || selectedIds.length < 1 || selectedIds.length > 12 || phase !== 'idle') return
    const currentRequest = ++requestId.current
    const controller = new AbortController()
    activeRequest.current = controller
    setPhase('removing')
    setError('')
    setCorrectedUrl('')
    setSaved(false)
    try {
      const formData = new FormData()
      formData.append('image', file, file.name)
      formData.append('selectedDetectionIds', JSON.stringify(selectedIds))
      const response = await fetch('/api/defects/remove', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      })
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok) throw new Error(apiError(payload, 'Defect removal failed. Please try again.'))
      if (!payload || typeof payload !== 'object' ||
          !('dataUrl' in payload) || typeof payload.dataUrl !== 'string' ||
          !payload.dataUrl.startsWith('data:image/png;base64,')) {
        throw new Error('The inpainting service returned an invalid image.')
      }
      if (currentRequest === requestId.current) {
        setCorrectedUrl(payload.dataUrl)
        if (onGenerated) {
          onGenerated(`Repaired ${selectedIds.length} defect${selectedIds.length === 1 ? '' : 's'} on fabric`, [{ name: `Repaired · ${file.name}`, url: payload.dataUrl }])
        }
      }
    } catch (reason) {
      if (controller.signal.aborted || currentRequest !== requestId.current) return
      setError(reason instanceof TypeError
        ? 'Could not reach the model service. Check that the backend is running.'
        : reason instanceof Error ? reason.message : 'Defect removal failed. Please try again.')
    } finally {
      if (currentRequest === requestId.current) setPhase('idle')
      if (activeRequest.current === controller) activeRequest.current = null
    }
  }

  return <section className="content-page defect-workspace">
    <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> Back to Tools</button>
    <div className="page-heading">
      <span className="eyebrow">LOCAL ONNX INFERENCE</span>
      <h1>{title}</h1>
      <p>{mode === 'detection'
        ? 'Analyze a fabric image with the local 20-class textile defect detector.'
        : 'Detect defects, select the regions to repair, and inpaint them with LaMa.'}</p>
    </div>
    <section className="workspace-card defect-upload-card">
      <div className="card-heading"><span className="step-badge">01</span><div><h2>Upload fabric image</h2><p>PNG or JPEG · up to 15 MB · local CPU inference</p></div></div>
      <input ref={fileInput} className="visually-hidden" type="file" accept="image/png,image/jpeg" onChange={handleFile} />
      {previewUrl
        ? <div className="defect-preview"><img src={previewUrl} alt="Uploaded fabric for defect analysis" /><span title={file?.name}>{file?.name}</span></div>
        : <button className="workspace-dropzone defect-upload-button" type="button" onClick={() => fileInput.current?.click()}><span className="upload-icon"><Upload size={19} /></span><b>Upload a fabric image</b><small>Choose a PNG or JPG to run the local model.</small></button>}
      {file && <button className="button button-outline change-image-button" type="button" onClick={() => fileInput.current?.click()}><Upload size={15} /> Re-upload / Change Image</button>}
      {phase !== 'idle' && <p className="defect-progress" role="status" aria-live="polite"><LoaderCircle size={16} className="spin" />{phase === 'detecting' ? mode === 'detection' ? 'Analyzing fabric…' : 'Detecting defects…' : 'Removing defects with LaMa…'}</p>}
      {error && <p className="inline-error" role="alert"><CircleHelp size={15} />{error}</p>}
      {result && result.detections.length === 0 && <p className="defect-empty-result" role="status">No defects detected by the model for this image.</p>}
    </section>
    {result && result.detections.length > 0 && <section className="workspace-card defect-results-card">
      <div className="card-heading"><span className="step-badge">02</span><div><h2>{mode === 'detection' ? 'Model detections' : 'Select defects to remove'}</h2><p>{result.detections.length} model detection{result.detections.length === 1 ? '' : 's'} · boxes and scores are actual inference output</p></div></div>
      {previewUrl && <div className="defect-image-stage">
        <img src={previewUrl} alt="Fabric with model-predicted defect locations" />
        {result.detections.map((detection) => <span
          className={`defect-box${mode === 'removal' && !selectedIds.includes(detection.id) ? ' defect-box-unselected' : ''}`}
          key={detection.id}
          onClick={() => { if (mode === 'removal') toggleDetection(detection.id, !selectedIds.includes(detection.id)) }}
          style={{
            left: `${detection.bbox.x / result.imageWidth * 100}%`,
            top: `${detection.bbox.y / result.imageHeight * 100}%`,
            width: `${detection.bbox.width / result.imageWidth * 100}%`,
            height: `${detection.bbox.height / result.imageHeight * 100}%`,
            cursor: mode === 'removal' ? 'pointer' : 'default',
            pointerEvents: mode === 'removal' ? 'auto' : 'none',
          }}
        ><b>{detection.label} · {(detection.confidence * 100).toFixed(1)}%</b></span>)}
      </div>}
      <div className="defect-detection-list">
        {result.detections.map((detection) => <label className={`defect-detection-row${selectedIds.includes(detection.id) ? ' defect-detection-row-selected' : ''}`} key={detection.id}>
          {mode === 'removal' && <input type="checkbox" checked={selectedIds.includes(detection.id)} onChange={(event) => toggleDetection(detection.id, event.target.checked)} />}
          <span><b>{detection.label}</b><small>{(detection.confidence * 100).toFixed(1)}% confidence · x {Math.round(detection.bbox.x)}, y {Math.round(detection.bbox.y)}</small></span>
        </label>)}
      </div>
      {mode === 'removal' && <button className="button button-primary" type="button" disabled={!selectedIds.length || phase !== 'idle'} onClick={removeSelected}>
        {phase === 'removing' ? <><LoaderCircle size={16} className="spin" /> Removing defects…</> : <><WandSparkles size={16} /> Remove {selectedIds.length} selected</>}
      </button>}
      {mode === 'removal' && result.detections.length > 12 && <p className="field-note">LaMa processes up to 12 selected defect regions per request.</p>}
    </section>}
    {correctedUrl && previewUrl && <section className="workspace-card defect-corrected-card">
      <div className="card-heading"><span className="step-badge">03</span><div><h2>Corrected fabric</h2><p>Only the selected masked regions were blended from the local LaMa output.</p></div></div>
      <div className="defect-comparison"><div><span>BEFORE · Original fabric</span><img src={previewUrl} alt="Original fabric before defect removal" /></div><div><span>AFTER · LaMa inpainting</span><img src={correctedUrl} alt="Fabric after model inpainting" /></div></div>
      <div className="defect-comparison-actions" style={{ marginTop: '14px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <button className="button button-primary" type="button" onClick={() => downloadDataUrl(correctedUrl, `weaveaugment-repaired-${file?.name || 'fabric.png'}`)}>
          <ArrowDownToLine size={15} /> Download repaired image
        </button>
        {onSaveImage && (
          <button className="button button-outline" type="button" onClick={() => { onSaveImage({ name: `Repaired · ${file?.name || 'Fabric'}`, url: correctedUrl }); setSaved(true) }} disabled={saved}>
            {saved ? <><Check size={15} /> Saved</> : <><Bookmark size={15} /> Save to workspace</>}
          </button>
        )}
      </div>
    </section>}
    <p className="defect-model-note"><ScanSearch size={14} /> The detector is trained on the Alibaba Tianchi Guangdong cloth-flaw dataset. Predictions may not generalize to other fabrics; review each detection and inpainted result.</p>
  </section>
}
