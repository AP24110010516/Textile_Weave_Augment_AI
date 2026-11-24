import { lazy, Suspense, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowRight, Bookmark, ChevronRight, CircleHelp,
  ClipboardList, Database, Download, History, Layers3, LogOut, Menu, Moon,
  ScanSearch, Settings2, ShieldAlert, Sparkles, Sun, Upload, UserRound, WandSparkles, X,
} from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
const AugmentationWorkspace = lazy(() => import('./AugmentationWorkspace'))
const DefectWorkspace = lazy(() => import('./DefectWorkspace'))

type Theme = 'light' | 'dark'
type SdxlStatus = 'checking' | 'configured' | 'needs-key' | 'unavailable'
type ModelStatus = 'checking' | 'configured' | 'needs-models' | 'unavailable'
type Tool = {
  title: string
  description: string
  path: string
  icon: LucideIcon
  status: 'Available' | 'Dataset tools' | 'Local inference'
}
type SessionUser = { name: string; email: string }
type GenerationActivity = {
  id: string
  createdAt: string
  tool: string
  summary: string
  images: Array<{ name: string; url: string }>
}
type DatasetActivity = { id: string; createdAt: string; imageCount: number; format: string }
type SavedImage = { id: string; name: string; url: string; tool: string; savedAt: string }
const tools: Tool[] = [
  { title: 'AI Defect Detection', description: 'Detect fabric defects with the local 20-class ONNX model.', path: '/tools/defect-detection', icon: ScanSearch, status: 'Local inference' },
  { title: 'Dataset Builder', description: 'Label, split, and export a textile image dataset.', path: '/tools/dataset-builder', icon: ClipboardList, status: 'Dataset tools' },
  { title: 'Color Variation Generator', description: 'Generate color-focused fabric variations with SDXL.', path: '/tools/color-variation', icon: WandSparkles, status: 'Available' },
  { title: 'Create Defects on Fabric', description: 'Generate synthetic defect images with the existing SDXL API.', path: '/tools/defect-creation', icon: Sparkles, status: 'Available' },
  { title: 'Remove Defects from Fabric', description: 'Repair selected fabric defects with local LaMa inpainting.', path: '/tools/defect-removal', icon: Layers3, status: 'Local inference' },
]
const protectedRoutes = new Set([
  '/tools', '/dashboard', '/tools/defect-detection', '/tools/dataset-builder',
  '/tools/color-variation', '/tools/defect-creation', '/tools/defect-removal',
  '/history', '/saved-images', '/dataset-library', '/settings',
])

function navigateTo(path: string, setRoute: (path: string) => void) {
  window.history.pushState({}, '', path)
  const [pathname, hash] = path.split('#')
  setRoute(pathname || '/')
  if (hash) window.setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' }), 50)
  else window.scrollTo({ top: 0, behavior: 'smooth' })
}

function Brand({ onClick, ariaLabel = 'WeaveAugment AI home' }: { onClick: () => void; ariaLabel?: string }) {
  return <button className="brand" onClick={onClick} aria-label={ariaLabel}><span className="brand-mark"><svg className="brand-weave-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h6v4h4v4h6M4 12h6v4h4v3h6M4 19l16-14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></span><span>weave<span className="brand-accent">augment</span></span><span className="brand-ai">AI</span></button>
}

function App() {
  const [route, setRoute] = useState(window.location.pathname)
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('weaveaugment-theme') === 'dark' ? 'dark' : 'light')
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 701px)').matches)
  const [sdxlStatus, setSdxlStatus] = useState<SdxlStatus>('checking')
  const [localModelStatus, setLocalModelStatus] = useState<{ detection: ModelStatus; removal: ModelStatus }>({ detection: 'checking', removal: 'checking' })
  const [user, setUser] = useState<SessionUser | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [activities, setActivities] = useState<GenerationActivity[]>([])
  const [datasetActivities] = useState<DatasetActivity[]>([])
  const [savedImages, setSavedImages] = useState<SavedImage[]>([])

  useEffect(() => {
    const onPopState = () => setRoute(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('weaveaugment-theme', theme)
  }, [theme])

  useEffect(() => {
    const syncTheme = (event: Event) => {
      const value = (event as CustomEvent<string>).detail
      if (value === 'light' || value === 'dark') setTheme(value)
    }
    window.addEventListener('weaveaugment-theme-change', syncTheme)
    return () => window.removeEventListener('weaveaugment-theme-change', syncTheme)
  }, [])

  useEffect(() => {
    let active = true
    fetch('/api/status')
      .then(async (response) => {
        if (!response.ok) throw new Error('Status request failed.')
        const payload: unknown = await response.json()
        if (!payload || typeof payload !== 'object' ||
            !('sdxlConfigured' in payload) || typeof payload.sdxlConfigured !== 'boolean' ||
            !('defectDetectionConfigured' in payload) || typeof payload.defectDetectionConfigured !== 'boolean' ||
            !('defectRemovalConfigured' in payload) || typeof payload.defectRemovalConfigured !== 'boolean') {
          throw new Error('The status service returned an invalid response.')
        }
        if (active) {
          setSdxlStatus(payload.sdxlConfigured ? 'configured' : 'needs-key')
          setLocalModelStatus({
            detection: payload.defectDetectionConfigured ? 'configured' : 'needs-models',
            removal: payload.defectRemovalConfigured ? 'configured' : 'needs-models',
          })
        }
      })
      .catch(() => {
        if (active) {
          setSdxlStatus('unavailable')
          setLocalModelStatus({ detection: 'unavailable', removal: 'unavailable' })
        }
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    fetch('/api/auth/session')
      .then(async (response) => {
        if (response.status === 401) return
        if (!response.ok) throw new Error('Could not load the account session.')
        const payload: unknown = await response.json()
        if (!payload || typeof payload !== 'object' || !('user' in payload) || !payload.user || typeof payload.user !== 'object' || !('name' in payload.user) || !('email' in payload.user) || typeof payload.user.name !== 'string' || typeof payload.user.email !== 'string') {
          throw new Error('The authentication service returned an invalid session.')
        }
        if (active) setUser({ name: payload.user.name, email: payload.user.email })
      })
      .catch(() => { if (active) setUser(null) })
      .finally(() => { if (active) setAuthLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (authLoading || user || !protectedRoutes.has(route)) return
    window.history.replaceState({}, '', '/login')
    setRoute('/login')
    window.scrollTo({ top: 0 })
  }, [route, authLoading, user])

  const go = (path: string) => {
    if (window.matchMedia('(max-width: 700px)').matches) setSidebarOpen(false)
    navigateTo(path, setRoute)
  }
  const openTools = () => {
    if (authLoading) return
    go(user ? '/tools' : '/login')
  }
  const activeTool = tools.find((tool) => tool.path === route)
  const recordGeneration = (tool: string, summary: string, images: Array<{ name: string; url: string }>) => {
    setActivities((current) => [{
      id: `${Date.now()}-${Math.random()}`,
      createdAt: new Date().toISOString(),
      tool,
      summary,
      images,
    }, ...current])
  }
  const saveImage = (image: { name: string; url: string }, tool: string) => {
    setSavedImages((current) => current.some((saved) => saved.url === image.url) ? current : [{
      ...image,
      id: `${Date.now()}-${Math.random()}`,
      tool,
      savedAt: new Date().toISOString(),
    }, ...current])
  }
  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // Clear session locally even if logout request fails
    }
    setUser(null)
    go('/')
  }

  const isPublicRoute = route === '/' || route === '/login' || route === '/signup' || route === '/how-it-works'
  if (isPublicRoute) {
    const isLanding = route === '/'
    return <div className={`app-shell public-shell ${isLanding ? 'landing-shell' : ''}`} data-theme={theme} data-page-background={
      route === '/how-it-works' ? 'how' : route === '/login' || route === '/signup' ? 'login' : undefined
    }>
      <PublicHeader
        route={route}
        onNavigate={go}
        onExplore={openTools}
        theme={theme}
        isLanding={isLanding}
        onThemeChange={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      />
      <main className="public-main">
        <AnimatePresence mode="wait">
          <motion.div key={route} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .14 }}>
            {route === '/' ? <Landing onExplore={openTools} authLoading={authLoading} /> :
              route === '/how-it-works' ? <HowItWorksPage onExplore={openTools} /> :
                <AuthPage route={route} onNavigate={go} onAuthenticated={setUser} />}
          </motion.div>
        </AnimatePresence>
      </main>
      {(route === '/' || route === '/how-it-works') && <CompactFooter onNavigate={go} />}
    </div>
  }

  const routeRequiresAuth = protectedRoutes.has(route)
  const page = routeRequiresAuth && (authLoading || !user) ? <PageLoading /> :
    route === '/tools' ? <ToolsSelection onNavigate={go} sdxlStatus={sdxlStatus} /> :
      route === '/dashboard' ? <Dashboard user={user!} activities={activities} datasets={datasetActivities} savedCount={savedImages.length} localModelStatus={localModelStatus} onNavigate={go} /> :
        route === '/tools/dataset-builder' ? <Suspense fallback={<PageLoading />}>
          <AugmentationWorkspace
            mode="dataset-builder"
            sdxlStatus={sdxlStatus}
            onBack={() => go('/tools')}
            onGenerated={(summary, images) => recordGeneration('Dataset Builder', summary, images)}
            onSaveImage={(image) => saveImage(image, 'Dataset Builder')}
          />
        </Suspense> :
          activeTool && (route === '/tools/defect-detection' || route === '/tools/defect-removal') ? <Suspense fallback={<PageLoading />}>
            <DefectWorkspace
              key={route}
              mode={route === '/tools/defect-detection' ? 'detection' : 'removal'}
              title={activeTool.title}
              onBack={() => go('/tools')}
              onGenerated={(summary, images) => recordGeneration(activeTool.title, summary, images)}
              onSaveImage={(image) => saveImage(image, activeTool.title)}
            />
          </Suspense> :
            route === '/tools/color-variation' || route === '/tools/defect-creation' ? <Suspense fallback={<PageLoading />}>
              <AugmentationWorkspace
                mode={route === '/tools/color-variation' ? 'color-variation' : 'defect-creation'}
                sdxlStatus={sdxlStatus}
                onBack={() => go('/tools')}
                onGenerated={(summary, images) => recordGeneration(route === '/tools/color-variation' ? 'Color Variation Generator' : 'Create Defects on Fabric', summary, images)}
                onSaveImage={(image) => saveImage(image, route === '/tools/color-variation' ? 'Color Variation Generator' : 'Create Defects on Fabric')}
              />
            </Suspense> :
              route === '/history' ? <HistoryPage activities={activities} datasets={datasetActivities} /> :
                route === '/saved-images' ? <SavedImagesPage images={savedImages} onRemove={(id) => setSavedImages((current) => current.filter((image) => image.id !== id))} /> :
                  route === '/dataset-library' ? <DatasetLibraryPage datasets={datasetActivities} /> :
                    route === '/settings' ? <SettingsPage user={user!} theme={theme} onThemeChange={() => setTheme(theme === 'light' ? 'dark' : 'light')} /> :
                      <NotFound onHome={() => go('/dashboard')} />

  return <AppLayout
    route={route}
    user={user}
    theme={theme}
    sidebarOpen={sidebarOpen}
    onNavigate={go}
    onThemeChange={() => setTheme(theme === 'light' ? 'dark' : 'light')}
    onMenuToggle={() => setSidebarOpen((open) => !open)}
    onLogout={logout}
  >
    <AnimatePresence mode="wait">
      <motion.div key={route} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: .12 }}>
        {page}
      </motion.div>
    </AnimatePresence>
  </AppLayout>
}

function Landing({ onExplore, authLoading }: { onExplore: () => void; authLoading: boolean }) {
  return <section className="landing-page">
    <div className="landing-content">
      <span className="eyebrow">TEXTILE IMAGE WORKSPACE</span>
      <h1>WeaveAugment AI</h1>
      <h2>Textile Defect Image Augmenter</h2>
      <p>Generate, analyse, and enhance textile images using AI-powered tools.</p>
      <span className="landing-tagline">Smarter data. Stronger models.</span>
      <button className="button button-landing" disabled={authLoading} onClick={onExplore}>
        {authLoading ? 'Checking account…' : 'Explore Tools'} <ArrowRight size={17} />
      </button>
    </div>
  </section>
}

function HowItWorksPage({ onExplore }: { onExplore: () => void }) {
  const steps: Array<{ title: string; description: string; icon: LucideIcon }> = [
    { title: 'Choose a workspace', description: 'Select the textile task that matches your project, from dataset preparation to image generation.', icon: Layers3 },
    { title: 'Upload your fabric image', description: 'Add a PNG or JPEG sample. Your upload is prepared for the selected workflow.', icon: Upload },
    { title: 'Configure and process', description: 'Set the available options and run the connected generation or local inference workflow.', icon: Settings2 },
    { title: 'Review and download', description: 'Inspect the output, save useful images, or download generated files and dataset exports.', icon: Download },
  ]
  return <section className="content-page how-page">
    <PageHeading eyebrow="WORKFLOW" title="How It Works" description="A clear path from a textile sample to an organized or generated result." />
    <div className="workflow-steps">
      {steps.map(({ title, description, icon: Icon }, index) => <article className="workflow-step" key={title}>
        <span className="workflow-step-number">{String(index + 1).padStart(2, '0')}</span>
        <span className="workflow-step-icon"><Icon size={21} strokeWidth={1.8} /></span>
        {index < steps.length - 1 && <ArrowRight className="workflow-arrow" size={18} aria-hidden="true" />}
        <h2>{title}</h2>
        <p>{description}</p>
      </article>)}
    </div>
    <div className="workflow-note"><CircleHelp size={17} /><p>Defect detection uses a local textile model. Defect removal runs LaMa inpainting on the selected detected regions.</p></div>
    <button className="button button-primary" onClick={onExplore}>Explore Tools <ArrowRight size={15} /></button>
  </section>
}

function ToolsSelection({ onNavigate, sdxlStatus }: { onNavigate: (path: string) => void; sdxlStatus: SdxlStatus }) {
  const selectionTools = tools.filter((tool) => [
    '/tools/dataset-builder',
    '/tools/color-variation',
    '/tools/defect-creation',
  ].includes(tool.path))
  return <section className="content-page tools-selection-page">
    <div className="tools-selection-top"><PageHeading eyebrow="WORKSPACE" title="Tools Selection" description="Choose a textile image workflow to continue." /><span className="tools-count">{String(selectionTools.length).padStart(2, '0')} workspaces</span></div>
    <div className="tool-selection-grid">{selectionTools.map((tool) => {
      const Icon = tool.icon
      const status = tool.status === 'Available'
        ? sdxlStatus === 'configured' ? 'SDXL ready' : sdxlStatus === 'checking' ? 'Checking SDXL' : 'SDXL setup required'
        : 'Dataset tools'
      return <button className="tool-selection-card" key={tool.path} onClick={() => onNavigate(tool.path)}>
        <span className="tool-selection-icon"><Icon size={21} strokeWidth={1.8} /></span>
        <span className="tool-selection-copy"><b>{tool.title}</b><small>{tool.description}</small><em className={`tool-status-label ${status === 'SDXL setup required' ? 'tool-status-pending' : ''}`}>{status}</em></span>
        <ArrowRight className="tool-selection-arrow" size={17} />
      </button>
    })}</div>
  </section>
}

function PublicHeader({ route, onNavigate, onExplore, theme, isLanding, onThemeChange }: { route: string; onNavigate: (path: string) => void; onExplore: () => void; theme: Theme; isLanding: boolean; onThemeChange: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const links = [
    { label: 'Home', path: '/' },
    { label: 'How It Works', path: '/how-it-works' },
  ]
  return <header className={`public-header ${isLanding ? 'public-header-landing' : ''}`}>
    <div className="public-nav">
      <Brand onClick={() => onNavigate('/')} />
      <nav className={menuOpen ? 'public-links public-links-open' : 'public-links'} aria-label="Main navigation">
        {links.map(({ label, path }) => <button key={label} className={route === path ? 'public-link-active' : ''} onClick={() => { onNavigate(path); setMenuOpen(false) }}>{label}</button>)}
        <button onClick={() => { onExplore(); setMenuOpen(false) }}>Explore Tools</button>
        <button className="public-mobile-login" onClick={() => { onNavigate('/login'); setMenuOpen(false) }}>Log in</button>
        <button className="public-mobile-theme" onClick={onThemeChange}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}{theme === 'light' ? 'Dark mode' : 'Light mode'}</button>
      </nav>
      <div className="public-actions">
        <button className="theme-toggle" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} onClick={onThemeChange}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button>
        <button className="button button-outline public-login" onClick={() => onNavigate('/login')}>Log in</button>
        <button className="button button-primary public-signup" onClick={() => onNavigate('/signup')}>Sign up <ArrowRight size={15} /></button>
        <button className="menu-toggle" onClick={() => setMenuOpen((open) => !open)} aria-label={menuOpen ? 'Close menu' : 'Open menu'}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
      </div>
    </div>
  </header>
}

function CompactFooter({ onNavigate }: { onNavigate: (path: string) => void }) {
  return <footer className="compact-footer"><div className="page-wrap"><Brand onClick={() => onNavigate('/')} /><span>Textile image tools with transparent capabilities.</span><span>© {new Date().getFullYear()} WeaveAugment AI</span></div></footer>
}

const navigationItems: Array<{ label: string; path: string; icon: LucideIcon }> = [
  { label: 'Tools Selection', path: '/tools', icon: ClipboardList },
  { label: 'Dashboard', path: '/dashboard', icon: Layers3 },
  { label: 'History', path: '/history', icon: History },
  { label: 'Saved Images', path: '/saved-images', icon: Bookmark },
  { label: 'Dataset Library', path: '/dataset-library', icon: Database },
  { label: 'Settings', path: '/settings', icon: Settings2 },
]

function AppLayout({ route, user, theme, sidebarOpen, onNavigate, onThemeChange, onMenuToggle, onLogout, children }: {
  route: string
  user: SessionUser | null
  theme: Theme
  sidebarOpen: boolean
  onNavigate: (path: string) => void
  onThemeChange: () => void
  onMenuToggle: () => void
  onLogout: () => Promise<void>
  children: ReactNode
}) {
  const [logoutError, setLogoutError] = useState('')
  const title = route === '/tools' ? 'Tools Selection' : navigationItems.find((item) => item.path === route)?.label ?? tools.find((tool) => tool.path === route)?.title ?? 'Workspace'
  const handleLogout = async () => {
    setLogoutError('')
    try { await onLogout() } catch (reason) { setLogoutError(reason instanceof Error ? reason.message : 'Could not sign out.') }
  }
  return <div className={`app-frame ${sidebarOpen ? 'app-sidebar-visible' : 'app-sidebar-hidden'}`} data-page-background={
    route === '/tools' ? 'tools' :
      route === '/tools/defect-detection' || route === '/tools/defect-removal' ? 'defect-detection' :
        route === '/tools/color-variation' || route === '/tools/defect-creation' ? 'augmentation' : undefined
  }>
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={onMenuToggle} />}
    <aside className={`app-sidebar ${sidebarOpen ? 'app-sidebar-open' : ''}`}>
      <div className="sidebar-brand"><Brand ariaLabel="Go to Dashboard" onClick={() => onNavigate('/dashboard')} /><button className="sidebar-close" onClick={onMenuToggle} aria-label="Close navigation"><X size={18} /></button></div>
      <span className="sidebar-caption">WORKSPACE</span>
      <nav className="sidebar-nav" aria-label="Workspace navigation">
        {navigationItems.map(({ label, path, icon: Icon }) => <button key={path} className={`sidebar-link ${route === path ? 'sidebar-link-active' : ''}`} onClick={() => onNavigate(path)} title={label}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{(route === path || (path === '/tools' && route.startsWith('/tools/'))) && <ChevronRight className="sidebar-chevron" size={14} />}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <button className="sidebar-theme" onClick={onThemeChange}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}<span>{theme === 'light' ? 'Dark mode' : 'Light mode'}</span><span className="theme-state">{theme}</span></button>
        <div className="sidebar-account"><span className="account-avatar">{user?.name?.slice(0, 1).toUpperCase() ?? <UserRound size={17} />}</span><span className="account-copy"><b>{user?.name ?? 'Guest workspace'}</b><small>{user?.email ?? 'Sign in to save your work'}</small></span></div>
        {logoutError && <p className="sidebar-error" role="alert">{logoutError}</p>}
        {user ? <button className="sidebar-logout" onClick={handleLogout}><LogOut size={15} />Sign out</button> : <button className="sidebar-logout" onClick={() => onNavigate('/login')}><UserRound size={15} />Log in</button>}
      </div>
    </aside>
    <div className="app-main">
      <header className="app-topbar">
        <button className="topbar-menu" onClick={onMenuToggle} aria-label={sidebarOpen ? 'Close navigation' : 'Open navigation'}><Menu size={19} /></button>
        <div className="topbar-breadcrumb"><span>WeaveAugment</span><ChevronRight size={14} /><b>{title}</b></div>
        <div className="topbar-actions"><span className="topbar-user">{user?.name ?? 'Guest'}</span><button className="theme-toggle" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} onClick={onThemeChange}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}</button></div>
      </header>
      <main className="app-content">{children}</main>
    </div>
  </div>
}

function PageLoading() {
  return <section className="content-page"><div className="loading-panel"><span className="loading-spinner" />Loading workspace…</div></section>
}

function Dashboard({ user, activities, datasets, savedCount, localModelStatus, onNavigate }: { user: SessionUser; activities: GenerationActivity[]; datasets: DatasetActivity[]; savedCount: number; localModelStatus: { detection: ModelStatus; removal: ModelStatus }; onNavigate: (path: string) => void }) {
  const generatedCount = activities.reduce((total, activity) => total + activity.images.length, 0)
  const quickLinks = tools
  const latestActivity = [...activities.map((item) => ({ id: item.id, label: item.tool, description: item.summary, date: item.createdAt })), ...datasets.map((item) => ({ id: item.id, label: 'Dataset export', description: `${item.imageCount} images · ${item.format}`, date: item.createdAt }))]
    .sort((left, right) => right.date.localeCompare(left.date)).slice(0, 4)
  const generatedImages = activities.flatMap((activity) => activity.images.map((image) => ({ ...image, tool: activity.tool }))).slice(0, 4)
  return <section className="content-page dashboard-page">
    <div className="dashboard-welcome"><div><span className="eyebrow">OVERVIEW</span><h1>Welcome back, {user.name}</h1><p>Your textile workspace at a glance.</p></div><button className="button button-primary" onClick={() => onNavigate('/tools/dataset-builder')}><Upload size={15} /> Add images</button></div>
    <div className="stat-grid">
      <StatCard label="Generated images" value={generatedCount} icon={Sparkles} detail="This browser session" />
      <StatCard label="Dataset exports" value={datasets.length} icon={Database} detail="Downloaded this session" />
      <StatCard label="Saved images" value={savedCount} icon={Bookmark} detail="Saved this session" />
    </div>
    <section className="dashboard-section"><div className="dashboard-section-head"><div><span className="eyebrow">QUICK ACCESS</span><h2>Your workspaces</h2></div><button className="quiet-link" onClick={() => onNavigate('/history')}>View history <ArrowRight size={14} /></button></div>
      <div className="quick-access-grid">{quickLinks.map((tool) => {
        const Icon = tool.icon
        const localStatus = tool.path === '/tools/defect-detection' ? localModelStatus.detection : localModelStatus.removal
        const status = tool.status === 'Local inference'
          ? localStatus === 'configured' ? 'Local model inference' : localStatus === 'checking' ? 'Checking local model' : localStatus === 'needs-models' ? 'Run model download' : 'Backend unavailable'
          : tool.status === 'Dataset tools' ? 'Local dataset tools' : 'SDXL image generation'
        return <button key={tool.path} className="quick-access-card" onClick={() => onNavigate(tool.path)}><span className="quick-access-icon"><Icon size={18} /></span><span><b>{tool.title}</b><small>{status}</small></span><ArrowRight size={15} /></button>
      })}</div>
    </section>
    <div className="dashboard-lower">
      <section className="dashboard-panel"><div className="dashboard-section-head"><div><span className="eyebrow">RECENT</span><h2>Recent activity</h2></div><button className="icon-link" aria-label="View history" onClick={() => onNavigate('/history')}><ArrowRight size={16} /></button></div>
        {latestActivity.length ? <div className="activity-list">{latestActivity.map((item) => <div className="activity-row" key={item.id}><span className="activity-dot" /><span><b>{item.label}</b><small>{item.description}</small></span><time>{new Date(item.date).toLocaleDateString()}</time></div>)}</div> : <p className="panel-empty">Generation and export activity from this session will appear here.</p>}
      </section>
      <section className="dashboard-panel"><div className="dashboard-section-head"><div><span className="eyebrow">OUTPUTS</span><h2>Recently generated</h2></div><button className="quiet-link" onClick={() => onNavigate('/saved-images')}>Saved images <ArrowRight size={14} /></button></div>
        {generatedImages.length ? <div className="recent-image-grid">{generatedImages.map((image, index) => <button className="recent-image" key={`${image.name}-${index}`} onClick={() => onNavigate('/history')}><img src={image.url} alt={image.name} /><span>{image.tool}</span></button>)}</div> : <p className="panel-empty">No generated images this session. Open an SDXL workspace to get started.</p>}
      </section>
    </div>
    <p className="session-note"><CircleHelp size={14} /> Dashboard counts reflect this browser session. They reset when you close or refresh the app.</p>
  </section>
}

function StatCard({ label, value, icon: Icon, detail }: { label: string; value: number; icon: LucideIcon; detail: string }) {
  return <article className="stat-card"><span className="stat-icon"><Icon size={18} /></span><span className="stat-copy"><small>{label}</small><b>{value}</b><em>{detail}</em></span></article>
}

function HistoryPage({ activities, datasets }: { activities: GenerationActivity[]; datasets: DatasetActivity[] }) {
  const imageCount = activities.reduce((total, activity) => total + activity.images.length, 0)
  const items = [
    ...activities.map((activity) => ({ id: activity.id, title: activity.tool, summary: activity.summary, createdAt: activity.createdAt, images: activity.images })),
    ...datasets.map((dataset) => ({ id: dataset.id, title: 'Dataset export', summary: `${dataset.imageCount} images · ${dataset.format} downloaded`, createdAt: dataset.createdAt, images: [] as GenerationActivity['images'] })),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return <section className="content-page">
    <PageHeading eyebrow="YOUR WORKSPACE" title="History" description={`${items.length} generation and dataset export activities · ${imageCount} generated images in this browser session.`} />
    {items.length ? <div className="history-list">{items.map((item) => <article className="history-card" key={item.id}><div className="history-card-top"><span className="quick-access-icon">{item.images.length ? <Sparkles size={17} /> : <Database size={17} />}</span><div><b>{item.title}</b><small>{item.summary}</small></div><time>{new Date(item.createdAt).toLocaleString()}</time></div>{item.images.length > 0 && <div className="history-images">{item.images.map((image) => <img src={image.url} alt={image.name} key={image.name} />)}</div>}</article>)}</div> : <div className="empty-panel"><span className="empty-icon"><History size={21} /></span><h2>No history yet</h2><p>Completed SDXL generations and dataset exports will be listed here for this browser session.</p></div>}
    <p className="session-note"><CircleHelp size={14} /> History is held in memory for this session and is not uploaded or persisted after refresh.</p>
  </section>
}

function SavedImagesPage({ images, onRemove }: { images: SavedImage[]; onRemove: (id: string) => void }) {
  return <section className="content-page">
    <PageHeading eyebrow="YOUR WORKSPACE" title="Saved images" description={`${images.length} image${images.length === 1 ? '' : 's'} saved in this browser session.`} />
    {images.length ? <div className="saved-image-grid">{images.map((image) => <article className="saved-image-card" key={image.id}><img src={image.url} alt={image.name} /><div className="saved-image-info"><b title={image.name}>{image.name}</b><small>{image.tool} · {new Date(image.savedAt).toLocaleDateString()}</small><div><button className="button button-outline" onClick={() => downloadDataUrl(image.url, image.name)}><Download size={14} /> Download</button><button className="text-button" onClick={() => onRemove(image.id)}>Remove</button></div></div></article>)}</div> : <div className="empty-panel"><span className="empty-icon"><Bookmark size={21} /></span><h2>No saved images</h2><p>Save an output from a generation workspace to find it here.</p></div>}
    <p className="session-note"><CircleHelp size={14} /> Saved images remain in memory for this session only.</p>
  </section>
}

function DatasetLibraryPage({ datasets }: { datasets: DatasetActivity[] }) {
  return <section className="content-page">
    <PageHeading eyebrow="YOUR WORKSPACE" title="Dataset library" description="Review the dataset exports created in this browser session." />
    {datasets.length ? <div className="library-table"><div className="library-table-head"><span>Export</span><span>Images</span><span>Format</span><span>Created</span></div>{datasets.map((dataset, index) => <div className="library-table-row" key={dataset.id}><span><b>Dataset export {datasets.length - index}</b><small>Downloaded locally</small></span><b>{dataset.imageCount}</b><span className="format-badge">{dataset.format}</span><time>{new Date(dataset.createdAt).toLocaleString()}</time></div>)}</div> : <div className="empty-panel"><span className="empty-icon"><Database size={21} /></span><h2>No dataset exports yet</h2><p>Build and download a dataset to add an export record to this session.</p></div>}
    <p className="session-note"><CircleHelp size={14} /> Exported files are downloaded to your device and are not retained by the application.</p>
  </section>
}

function SettingsPage({ user, theme, onThemeChange }: { user: SessionUser; theme: Theme; onThemeChange: () => void }) {
  return <section className="content-page">
    <PageHeading eyebrow="PREFERENCES" title="Profile and settings" description="Manage your account details and appearance preferences." />
    <div className="settings-grid"><article className="settings-card"><span className="eyebrow">ACCOUNT</span><div className="settings-profile"><span className="account-avatar">{user.name.slice(0, 1).toUpperCase()}</span><div><b>{user.name}</b><small>{user.email}</small></div></div><p className="settings-note">Profile editing is not configured. Your account information is managed through your authenticated account.</p></article>
      <article className="settings-card"><span className="eyebrow">APPEARANCE</span><h2>Color theme</h2><p className="settings-note">Choose the appearance used across all pages in this app.</p><button className="theme-setting" onClick={onThemeChange}><span className="theme-setting-icon">{theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}</span><span><b>{theme === 'light' ? 'Light theme' : 'Dark theme'}</b><small>Click to switch to {theme === 'light' ? 'dark' : 'light'} mode</small></span><span className="theme-state">{theme}</span></button></article></div>
  </section>
}

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="page-heading"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
}

function AuthPage({ route, onNavigate, onAuthenticated }: { route: string; onNavigate: (path: string) => void; onAuthenticated: (user: SessionUser) => void }) {
  const isSignup = route === '/signup'
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    if (isSignup && password !== confirmation) {
      setError('The passwords do not match.')
      return
    }
    setSubmitting(true)
    try {
      const response = await fetch(`/api/auth/${isSignup ? 'signup' : 'login'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isSignup ? { name, email, password } : { email, password, rememberMe }),
      })
      const payload: unknown = await response.json().catch(() => null)
      const apiError = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : 'Authentication failed. Please try again.'
      if (!response.ok) throw new Error(apiError)
      if (!payload || typeof payload !== 'object' || !('user' in payload) || !payload.user || typeof payload.user !== 'object' || !('name' in payload.user) || !('email' in payload.user) || typeof payload.user.name !== 'string' || typeof payload.user.email !== 'string') {
        throw new Error('The authentication service returned an invalid account.')
      }
      onAuthenticated({ name: payload.user.name, email: payload.user.email })
      onNavigate('/tools')
    } catch (reason) {
      setError(reason instanceof TypeError ? 'Could not reach the authentication service. Try again shortly.' : reason instanceof Error ? reason.message : 'Authentication failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return <section className="auth-page page-wrap">
    <div className="auth-visual"><span className="eyebrow eyebrow-light">WEAVEAUGMENT AI</span><h1>Better tools for textile imagery.</h1><p>Access textile image workspaces built around generation and dataset preparation.</p><span className="auth-visual-mark"><Layers3 size={34} /></span></div>
    <form className="auth-panel auth-form" onSubmit={submit}>
      <span className="eyebrow">{isSignup ? 'CREATE YOUR ACCOUNT' : 'WELCOME BACK'}</span>
      <h2>{isSignup ? 'Sign up' : 'Log in'}</h2>
      <p>{isSignup ? 'Create a secure account to access your workspace.' : 'Sign in to continue to your workspace.'}</p>
      {isSignup && <label>Full name<input autoComplete="name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>}
      <label>Email address<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>Password<input type={showPassword ? 'text' : 'password'} autoComplete={isSignup ? 'new-password' : 'current-password'} required value={password} onChange={(event) => setPassword(event.target.value)} />{!isSignup && <small>Password reset is unavailable until email delivery is configured.</small>}</label>
      {isSignup && <label>Confirm password<input type={showPassword ? 'text' : 'password'} autoComplete="new-password" required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>}
      {!isSignup && <label className="show-password"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} /> Remember me for 7 days</label>}
      <label className="show-password"><input type="checkbox" checked={showPassword} onChange={(event) => setShowPassword(event.target.checked)} /> Show password</label>
      {error && <p className="auth-error" role="alert"><CircleHelp size={14} />{error}</p>}
      <button className="button button-primary button-full" type="submit" disabled={submitting}>{submitting ? 'Please wait…' : isSignup ? 'Create account' : 'Log in'} <ArrowRight size={15} /></button>
      <p className="auth-security"><ShieldAlert size={14} /> Passwords are hashed on the server. Sessions use secure, HttpOnly cookies.</p>
      <button className="auth-switch" type="button" onClick={() => onNavigate(isSignup ? '/login' : '/signup')}>{isSignup ? 'Already have an account?' : 'New to WeaveAugment?'} <u>{isSignup ? 'Log in' : 'Sign up'}</u></button>
    </form>
  </section>
}

function NotFound({ onHome }: { onHome: () => void }) {
  return <section className="inner-page not-found page-wrap"><span className="workspace-icon"><CircleHelp size={22} /></span><h1>We couldn’t find that page.</h1><p>Try returning to the available textile workspaces.</p><button className="button button-primary" onClick={onHome}>Back home <ArrowRight size={15} /></button></section>
}

function downloadDataUrl(url: string, filename: string) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export default App
