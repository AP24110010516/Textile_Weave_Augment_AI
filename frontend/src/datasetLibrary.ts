import JSZip from 'jszip'

export type DatasetImage = { name: string; dataUrl: string }

export type DatasetLibraryDraft = {
  name: string
  fabricType: string
  defectType: string
  sourceImage: { name: string; type: string; size: number }
  imageStrength: number
  uiImageStrength?: number
  requestedVariations: number
  actualVariations: number
  positivePrompt: string
  negativePrompt: string
  provider: string
  model: string
  images: DatasetImage[]
}

export type DatasetLibraryRecord = DatasetLibraryDraft & {
  id: string
  savedAt: string
}

type StoredDataset = DatasetLibraryRecord & { ownerKey: string }

const databaseName = 'weaveaugment-dataset-library'
const storeName = 'datasets'
const ownerIndexName = 'ownerKey'
let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('This browser does not support persistent dataset storage.'))
  }
  if (databasePromise) return databasePromise

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      const store = database.objectStoreNames.contains(storeName)
        ? request.transaction?.objectStore(storeName)
        : database.createObjectStore(storeName, { keyPath: 'id' })
      if (store && !store.indexNames.contains(ownerIndexName)) {
        store.createIndex(ownerIndexName, ownerIndexName, { unique: false })
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        databasePromise = null
      }
      resolve(database)
    }
    request.onerror = () => {
      databasePromise = null
      reject(request.error ?? new Error('Could not open persistent dataset storage.'))
    }
  })
  return databasePromise
}

export async function listDatasetLibrary(ownerKey: string): Promise<DatasetLibraryRecord[]> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly')
    const request = transaction.objectStore(storeName).index(ownerIndexName).getAll(ownerKey)
    let records: DatasetLibraryRecord[] = []
    request.onsuccess = () => {
      records = (request.result as StoredDataset[])
        .map(({ ownerKey: _ownerKey, ...record }) => record)
        .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
    }
    request.onerror = () => reject(request.error ?? new Error('Could not load saved datasets.'))
    transaction.oncomplete = () => resolve(records)
    transaction.onabort = () => reject(transaction.error ?? new Error('Loading saved datasets was interrupted.'))
  })
}

export async function saveDatasetToLibrary(
  dataset: DatasetLibraryDraft,
  ownerKey: string,
): Promise<DatasetLibraryRecord> {
  const record: DatasetLibraryRecord = {
    ...dataset,
    id: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
  }
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).add({ ...record, ownerKey } satisfies StoredDataset)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save the dataset.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Saving the dataset was interrupted.'))
  })
  return record
}

export async function createDatasetArchive(dataset: DatasetLibraryRecord): Promise<Blob> {
  if (dataset.images.length !== dataset.requestedVariations ||
      dataset.images.length !== dataset.actualVariations || dataset.images.length === 0) {
    throw new Error('The saved dataset does not contain all requested generated images.')
  }
  const archive = new JSZip()
  const metadata = { ...dataset, images: dataset.images.map(({ name }) => ({ name })) }
  archive.file('metadata.json', JSON.stringify(metadata, null, 2))
  for (const image of dataset.images) {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl)
    if (!match) throw new Error(`The generated image "${image.name}" is not a valid PNG data URL.`)
    archive.file(`images/${image.name}`, match[1], { base64: true })
  }
  return archive.generateAsync({ type: 'blob' })
}
