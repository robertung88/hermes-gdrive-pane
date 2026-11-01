/**
 * Google Drive pane for the Hermes desktop app.
 *
 * A dockable browser for the real Drive tree: folders, recent, shared and
 * starred views, full-text search, one file's metadata, open-in-Drive, copy a
 * link, and a handoff of the item to the agent — in this chat or in a fresh
 * chat after picking a Hermes profile — with the file id and path inline.
 *
 * Data: this plugin's own Python backend (`dashboard/plugin_api.py`) through
 * `ctx.rest`. The backend reads the active profile's `google_token.json`, so no
 * token ever appears in this file. Read-only: downloads, moves and shares go
 * through gog-robert / the rclone mount, not this pane.
 *
 * Plain ESM, loaded uncompiled: UI is jsx() calls, not JSX syntax. Only
 * @hermes/plugin-sdk, react and react/jsx-runtime resolve here.
 */

import {
  Badge,
  Button,
  cn,
  Codicon,
  EmptyState,
  ErrorState,
  GlyphSpinner,
  host,
  SearchField,
  SegmentedControl,
  Separator,
  StatusDot,
  useMutation,
  useQuery,
  useQueryClient,
  useValue
} from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-gdrive-pane'
const DRIVE_WEB = 'https://drive.google.com/drive/my-drive'

const SCOPES = [
  { id: 'browse', label: 'Browse' },
  { id: 'recent', label: 'Recent' },
  { id: 'shared', label: 'Shared' },
  { id: 'starred', label: 'Starred' }
]

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

function pad(n) {
  return String(n).padStart(2, '0')
}

function humanSize(bytes) {
  const n = Number(bytes) || 0

  if (!n) {
    return ''
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB']

  let value = n
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function shortDate(value) {
  const raw = String(value || '')

  if (!raw) {
    return ''
  }

  const date = new Date(raw)

  if (Number.isNaN(date.getTime())) {
    return raw.slice(0, 10)
  }

  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

  return sameYear ? stamp.slice(5) : stamp
}

function fileKindLabel(file) {
  if (!file) {
    return ''
  }

  if (file.isFolder) {
    return 'Folder'
  }

  const mime = String(file.mimeType || '')
  const map = {
    'application/pdf': 'PDF',
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.form': 'Google Form',
    'application/vnd.google-apps.drawing': 'Drawing',
    'application/vnd.google-apps.script': 'Apps Script',
    'application/vnd.google-apps.shortcut': 'Shortcut',
    'application/zip': 'Archive',
    'text/markdown': 'Markdown'
  }

  if (map[mime]) {
    return map[mime]
  }

  if (file.extension) {
    return file.extension.toUpperCase()
  }

  return mime.split('.').pop().split('/').pop() || 'File'
}

function fileGlyph(file) {
  if (!file) {
    return 'file'
  }

  if (file.isFolder) {
    return 'folder'
  }

  const mime = String(file.mimeType || '')

  if (mime === SHORTCUT_MIME) {
    return 'link'
  }
  if (mime === 'application/pdf') {
    return 'file-pdf'
  }
  if (mime === 'application/vnd.google-apps.document') {
    return 'book'
  }
  if (mime === 'application/vnd.google-apps.spreadsheet') {
    return 'table'
  }
  if (mime === 'application/vnd.google-apps.presentation') {
    return 'graph'
  }
  if (mime.startsWith('image/')) {
    return 'file-media'
  }
  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    return 'play-circle'
  }
  if (mime === 'text/markdown') {
    return 'markdown'
  }
  if (mime.includes('zip') || mime.includes('tar')) {
    return 'file-zip'
  }
  if (mime.startsWith('text/')) {
    return 'file-text'
  }

  return 'file'
}

/* ------------------------------------------------------------------ */
/* agent handoff                                                       */
/* ------------------------------------------------------------------ */

function submitWithRetry(address, text, tries = 8) {
  return new Promise(resolve => {
    let left = tries

    const tick = () => {
      if (host.composer.submit(address, text)) {
        resolve(true)

        return
      }

      left -= 1

      if (left <= 0) {
        resolve(false)

        return
      }

      window.setTimeout(tick, 250)
    }

    tick()
  })
}

function drivePrompt(file, trail) {
  const path = ['My Drive', ...(trail || []).map(step => step.name), file.name].join(' / ')
  const lines = [
    'Drive item — handed over from the Drive pane.',
    '',
    `Name: ${file.name}`,
    `Kind: ${fileKindLabel(file)}${file.mimeType ? ` (${file.mimeType})` : ''}`,
    `Id: ${file.id}`,
    file.isFolder ? 'This is a FOLDER.' : '',
    `Path: ${path}`,
    file.modifiedTime ? `Modified: ${file.modifiedTime}` : '',
    file.owner ? `Owner: ${file.owner}${file.shared ? ' · shared' : ''}` : '',
    file.size ? `Size: ${humanSize(file.size)}` : '',
    file.webViewLink ? `Open: ${file.webViewLink}` : '',
    ''

  ]

  if (file.isFolder) {
    lines.push(
      'List what is inside it — from the pane, or directly:',
      `  gog-robert drive search "'${file.id}' in parents" --json`,
      'The rclone mount at ~/GoogleDrive shows the same tree for browsing.',
      ''
    )
  } else {
    lines.push(
      'Fetch it before answering anything about its contents:',
      `  gog-robert drive download "${file.id}" --out ~/Downloads`,
      '(one id per call; Google Docs/Sheets export to PDF; the saved file is <id>_<name> with no extension,',
      'so rename it before reading it. `read_file` handles PDFs directly.)',
      ''
    )
  }

  lines.push(
    'Do not move, rename, trash or share anything in Drive unless I ask for it in this turn.',
    'Then reply here with a short summary of what it contains or what you changed.'
  )

  return lines.filter(line => line !== '').join('\n')
}

async function handToAgent(file, trail, target) {
  const text = drivePrompt(file, trail)
  let sent = false

  if (!target || target === 'current') {
    sent = host.composer.submit(null, text)
  } else {
    try {
      host.newChat(target)
    } catch {
      /* older desktop: fall back to the active chat below */
    }

    sent = await submitWithRetry('new', text)

    if (!sent) {
      sent = host.composer.submit(null, text)
    }
  }

  if (sent) {
    host.notify({
      kind: 'success',
      message: target && target !== 'current' ? `Sent to ${target}` : 'Sent to the current chat'
    })
  } else {
    host.notify({ kind: 'warning', message: 'No chat answered — open a chat tab, then try again' })
  }

  return sent
}

/* ------------------------------------------------------------------ */
/* profile picker                                                      */
/* ------------------------------------------------------------------ */

function useProfiles() {
  return useQuery({
    queryKey: [ID, 'profiles'],
    staleTime: 60_000,
    queryFn: async () => {
      if (host.profiles && typeof host.profiles.list === 'function') {
        const res = await host.profiles.list()

        return (res && res.profiles) || []
      }

      return []
    }
  })
}

const PROFILE_HINT = {
  brainiac: 'vault, ops, property',
  hearth: 'family, household',
  productlab: 'venture, products',
  default: 'general'
}

function AgentPicker({ onCancel, onPick, subtitle, title }) {
  const profilesQ = useProfiles()
  const active = useValue(host.state.profile)
  const rows = (profilesQ.data || []).filter(p => p && p.name)
  const ordered = [...rows].sort((a, b) => {
    if (a.name === active) return -1
    if (b.name === active) return 1

    return String(a.name).localeCompare(String(b.name))
  })
  const label = p => p.display_name || p.bot_title || p.name

  return jsx('div', {
    className: 'absolute inset-0 z-50 flex items-start justify-center bg-black/40 p-2',
    onClick: onCancel,
    children: jsxs('div', {
      className:
        'mt-6 flex max-h-[80%] w-full flex-col gap-1 overflow-y-auto rounded-md border border-(--ui-stroke-secondary) bg-background p-2 text-xs text-foreground shadow-xl',
      onClick: e => e.stopPropagation(),
      children: [
        jsx('div', {
          className: 'px-1 text-[0.6875rem] text-(--ui-text-secondary)',
          children: title || 'Send this file to…'
        }),
        subtitle
          ? jsx('div', {
              className: 'truncate px-1 pb-1 text-[0.65rem] text-(--ui-text-quaternary)',
              children: subtitle
            })
          : null,
        jsx('button', {
          className:
            'flex flex-col items-start gap-0.5 rounded-[3px] px-2 py-1.5 text-left hover:bg-(--chrome-action-hover)',
          onClick: () => onPick('current'),
          type: 'button',
          children: [
            jsx('span', { className: 'text-xs text-(--ui-text-primary)', children: 'This chat' }),
            jsx('span', {
              className: 'text-[0.65rem] text-(--ui-text-quaternary)',
              children: 'send into the conversation in front of you'
            })
          ]
        }),
        jsx('div', { className: 'my-0.5 border-t border-(--ui-stroke-secondary)' }),
        ...ordered.map(p =>
          jsx(
            'button',
            {
              className: cn(
                'flex flex-col items-start gap-0.5 rounded-[3px] px-2 py-1.5 text-left hover:bg-(--chrome-action-hover)',
                p.name === active && 'bg-(--ui-bg-quaternary)/60'
              ),
              onClick: () => onPick(p.name),
              type: 'button',
              children: [
                jsxs('span', {
                  className: 'flex items-center gap-1 text-xs text-(--ui-text-primary)',
                  children: [
                    jsx('span', { children: label(p) }),
                    p.name === active ? jsx(Badge, { variant: 'muted', children: 'current' }) : null
                  ]
                }),
                jsx('span', {
                  className: 'text-[0.65rem] text-(--ui-text-quaternary)',
                  children: PROFILE_HINT[p.name] || `new chat in ${p.name}`
                })
              ]
            },
            p.name
          )
        ),
        profilesQ.isLoading
          ? jsx('div', {
              className: 'px-2 py-1 text-[0.65rem] text-(--ui-text-quaternary)',
              children: 'Loading profiles…'
            })
          : null,
        profilesQ.error
          ? jsx('div', {
              className: 'px-2 py-1 text-[0.65rem] text-destructive',
              children: String(profilesQ.error.message || profilesQ.error)
            })
          : null,
        jsx(Button, {
          className: 'mt-1 self-end',
          onClick: onCancel,
          size: 'xs',
          type: 'button',
          variant: 'ghost',
          children: 'Cancel'
        })
      ]
    })
  })
}

/* ------------------------------------------------------------------ */
/* data                                                                */
/* ------------------------------------------------------------------ */

function errorText(error) {
  const raw = String((error && error.message) || error || '')

  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw
}

function useStatus(ctx) {
  return useQuery({
    queryKey: [ID, 'status', 'v1'],
    staleTime: 300_000,
    retry: false,
    queryFn: () => ctx.rest('/status')
  })
}

function useFiles(ctx, params, enabled) {
  return useQuery({
    enabled,
    queryKey: [ID, 'files', 'v1', params.scope, params.folderId, params.search],
    queryFn: async () => {
      const query = new URLSearchParams({
        folderId: params.folderId || '',
        q: params.search || '',
        pageSize: '100',
        scope: params.scope
      })

      return ctx.rest(`/files?${query.toString()}`)
    },
    staleTime: 20_000
  })
}

function useFileDetail(ctx, fileId) {
  return useQuery({
    enabled: Boolean(fileId),
    queryKey: [ID, 'file', 'v1', fileId],
    retry: false,
    staleTime: 60_000,
    queryFn: () => ctx.rest(`/file?fileId=${encodeURIComponent(fileId)}`)
  })
}

/* ------------------------------------------------------------------ */
/* rows                                                               */
/* ------------------------------------------------------------------ */

function FileRow({ file, onOpen }) {
  const meta = [fileKindLabel(file), file.size ? humanSize(file.size) : '', shortDate(file.modifiedTime)]
    .filter(Boolean)
    .join(' · ')

  return jsxs(
    'button',
    {
      className:
        'group flex w-full items-center gap-2 rounded-[3px] px-1.5 py-1 text-left hover:bg-(--chrome-action-hover)',
      onClick: () => onOpen(file),
      type: 'button',
      children: [
        jsx(Codicon, {
          className: file.isFolder ? 'text-(--ui-accent)' : 'text-(--ui-text-quaternary)',
          name: fileGlyph(file),
          size: '1rem'
        }),
        jsxs('div', {
          className: 'min-w-0 flex-1',
          children: [
            jsx('div', {
              className: 'truncate text-xs leading-4 text-(--ui-text-primary)',
              children: file.name
            }),
            jsx('div', {
              className: 'truncate text-[0.65rem] leading-4 text-(--ui-text-quaternary)',
              children: meta
            })
          ]
        }),
        file.starred ? jsx(Codicon, { className: 'text-amber-500', name: 'star-full', size: '0.7rem' }) : null,
        file.shared ? jsx(Codicon, { className: 'text-(--ui-text-quaternary)', name: 'organization', size: '0.7rem' }) : null,
        file.isFolder
          ? jsx(Codicon, { className: 'text-(--ui-text-quaternary)', name: 'chevron-right', size: '0.8rem' })
          : null
      ]
    },
    file.id
  )
}

function currentName(trail) {
  return trail.length ? trail[trail.length - 1].name : 'My Drive'
}

function Breadcrumbs({ onJump, trail }) {
  return jsxs('div', {
    className: 'flex flex-wrap items-center gap-0.5 px-1 pb-1 text-[0.65rem] text-(--ui-text-quaternary)',
    children: [
      jsx('button', {
        className: 'flex items-center gap-1 rounded-[3px] px-1 py-0.5 hover:bg-(--chrome-action-hover)',
        onClick: () => onJump(-1),
        type: 'button',
        children: [
          jsx(Codicon, { name: 'home', size: '0.75rem' }),
          jsx('span', { children: 'My Drive' })
        ]
      }),
      ...trail.map((step, index) =>
        jsxs(
          'span',
          {
            className: 'flex items-center gap-0.5',
            children: [
              jsx(Codicon, { className: 'opacity-60', name: 'chevron-right', size: '0.7rem' }),
              jsx('button', {
                className: 'max-w-[7rem] truncate rounded-[3px] px-1 py-0.5 hover:bg-(--chrome-action-hover)',
                onClick: () => onJump(index),
                type: 'button',
                children: step.name
              })
            ]
          },
          `${step.id}-${index}`
        )
      )
    ]
  })
}

/* ------------------------------------------------------------------ */
/* detail                                                             */
/* ------------------------------------------------------------------ */

function DetailLine({ children, label }) {
  return jsxs('div', {
    className: 'flex gap-2 px-1 py-0.5',
    children: [
      jsx('span', {
        className: 'w-[3.6rem] shrink-0 text-[0.65rem] leading-4 text-(--ui-text-quaternary)',
        children: label
      }),
      jsx('span', { className: 'min-w-0 flex-1 break-words text-[0.7rem] leading-4 text-(--ui-text-secondary)', children })
    ]
  })
}

function FileDetail({ ctx, fileId, onAsk, onBack, onOpenFolder }) {
  const qc = useQueryClient()
  const detailQ = useFileDetail(ctx, fileId)
  const file = detailQ.data && detailQ.data.file

  const save = useMutation({
    mutationFn: payload => ctx.rest('/download', { body: payload, method: 'POST' }),
    onError: error => host.notify({ kind: 'error', message: errorText(error) }),
    onSuccess: data => {
      host.notify({
        kind: 'success',
        message: `Saved ${data.name} (${humanSize(data.bytes)}) to ${data.path.split('/').slice(-2).join('/')}`
      })
      Promise.resolve(ctx.os.revealPath(data.path)).catch(() => {})
    }
  })

  if (detailQ.isLoading) {
    return jsx('div', {
      className: 'flex items-center gap-2 p-2 text-xs text-(--ui-text-tertiary)',
      children: [jsx(GlyphSpinner, { key: 's' }), jsx('span', { key: 't', children: 'Reading file…' })]
    })
  }

  if (!file) {
    return jsxs('div', {
      className: 'flex flex-col gap-2 p-2',
      children: [
        jsx(Button, { onClick: onBack, size: 'xs', type: 'button', variant: 'ghost', children: '← Files' }),
        jsx(ErrorState, {
          description: errorText(detailQ.error) || 'The file could not be read.',
          title: 'No detail'
        })
      ]
    })
  }

  const openExternal = url => {
    if (!url) {
      return
    }

    Promise.resolve(ctx.os.openExternal(url)).then(ok => {
      if (!ok) {
        host.notify({ kind: 'warning', message: 'Could not open the browser' })
      }
    })
  }

  const saveCopy = async () => {
    // The native dialog hands back a path on the BACKEND's filesystem, which is
    // exactly what the download route writes to.
    const picked = await ctx.os.pickSavePath({
      defaultPath: file.name,
      title: `Save ${file.name}`
    })

    if (!picked) {
      return
    }

    save.mutate({ fileId: file.id, targetPath: picked })
  }

  return jsxs('div', {
    className: 'flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-3',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1',
        children: [
          jsx(Button, { onClick: onBack, size: 'xs', type: 'button', variant: 'ghost', children: '← Files' }),
          jsx('span', { className: 'flex-1' }),
          jsx(Button, {
            onClick: () => openExternal(file.webViewLink || DRIVE_WEB),
            size: 'xs',
            title: 'Open in Google Drive',
            type: 'button',
            variant: 'ghost',
            children: jsx(Codicon, { name: 'link-external', size: '0.85rem' })
          }),
          jsx(Button, {
            onClick: () => {
              Promise.resolve(ctx.os.writeClipboard(file.name)).then(ok => {
                host.notify({
                  kind: ok ? 'success' : 'warning',
                  message: ok ? 'Name copied' : 'Clipboard unavailable'
                })
              })
            },
            size: 'xs',
            title: 'Copy the name',
            type: 'button',
            variant: 'ghost',
            children: jsx(Codicon, { name: 'copy', size: '0.85rem' })
          })
        ]
      }),
      jsxs('div', {
        className: 'flex items-start gap-2 px-1',
        children: [
          jsx(Codicon, {
            className: file.isFolder ? 'mt-0.5 text-(--ui-accent)' : 'mt-0.5 text-(--ui-text-quaternary)',
            name: fileGlyph(file),
            size: '1.1rem'
          }),
          jsxs('div', {
            className: 'min-w-0',
            children: [
              jsx('div', {
                className: 'break-words text-[0.8rem] font-medium leading-5 text-(--ui-text-primary)',
                children: file.name
              }),
              jsxs('div', {
                className: 'flex flex-wrap items-center gap-1 text-[0.65rem] leading-4 text-(--ui-text-tertiary)',
                children: [
                  jsx('span', { children: fileKindLabel(file) }),
                  file.shared ? jsx(Badge, { variant: 'muted', children: 'shared' }) : null,
                  file.starred ? jsx(Badge, { variant: 'muted', children: 'starred' }) : null
                ]
              })
            ]
          })
        ]
      }),
      jsx(Separator, { className: 'my-1' }),
      file.size ? jsx(DetailLine, { label: 'Size', children: humanSize(file.size) }) : null,
      file.modifiedTime ? jsx(DetailLine, { label: 'Modified', children: shortDate(file.modifiedTime) }) : null,
      file.owner ? jsx(DetailLine, { label: 'Owner', children: file.owner }) : null,
      file.parentFolders && file.parentFolders.length
        ? jsx(DetailLine, {
            label: 'In',
            children: jsx('button', {
              className: 'truncate text-left text-(--ui-accent) hover:underline',
              onClick: () => onOpenFolder(file.parentFolders[0]),
              type: 'button',
              children: file.parentFolders.map(f => f.name).join(' / ')
            })
          })
        : null,
      file.mimeType ? jsx(DetailLine, { label: 'Type', children: file.mimeType }) : null,
      file.description ? jsx(DetailLine, { label: 'About', children: file.description }) : null,
      jsxs('div', {
        className: 'mt-2 flex flex-wrap items-center gap-1.5 px-1',
        children: [
          jsx(Button, {
            onClick: () => onAsk(file),
            size: 'xs',
            type: 'button',
            variant: 'default',
            children: [jsx(Codicon, { key: 'i', name: 'comment-discussion', size: '0.8rem' }), 'Ask agent']
          }),
          jsx(Button, {
            onClick: () => openExternal(file.webViewLink || DRIVE_WEB),
            size: 'xs',
            type: 'button',
            variant: 'outline',
            children: 'Open in Drive'
          }),
          file.isFolder
            ? jsx(Button, {
                onClick: () => onOpenFolder(file),
                size: 'xs',
                type: 'button',
                variant: 'ghost',
                children: 'Browse folder'
              })
            : jsx(Button, {
                disabled: save.isPending,
                onClick: saveCopy,
                size: 'xs',
                type: 'button',
                variant: 'outline',
                children: save.isPending ? 'Saving…' : 'Save a copy'
              })
        ]
      }),
      save.error
        ? jsx('div', { className: 'px-1 text-[0.65rem] leading-4 text-destructive', children: errorText(save.error) })
        : null,
      jsx('div', {
        className: 'px-1 pt-2 text-[0.6rem] leading-4 text-(--ui-text-quaternary)',
        children: file.isFolder
          ? 'Folders are listings only — a folder is never downloaded.'
          : 'Save a copy writes to a path you pick. Moves, renames and sharing stay with the agent.'
      })
    ]
  })
}

/* ------------------------------------------------------------------ */
/* pane                                                               */
/* ------------------------------------------------------------------ */

function DrivePane({ ctx }) {
  const qc = useQueryClient()
  const [trail, setTrail] = useState([])
  const [scope, setScope] = useState('browse')
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [detailId, setDetailId] = useState(null)
  const [agentFile, setAgentFile] = useState(null)
  const gateway = useValue(host.state.gateway)
  const statusQ = useStatus(ctx)

  const current = trail.length ? trail[trail.length - 1].id : ''

  const upload = useMutation({
    mutationFn: payload => ctx.rest('/upload', { body: payload, method: 'POST' }),
    onError: error => host.notify({ kind: 'error', message: errorText(error) }),
    onSuccess: data => {
      qc.invalidateQueries({ queryKey: [ID] })
      host.notify({ kind: 'success', message: `Uploaded ${data.name} (${humanSize(data.bytes)})` })
    }
  })

  const uploadHere = async () => {
    const picked = await ctx.os.pickOpenPath({ title: `Upload into ${currentName(trail)}` })

    if (!picked) {
      return
    }

    upload.mutate({ folderId: current, path: picked })
  }
  const filesQ = useFiles(
    ctx,
    { folderId: current, scope: search ? 'search' : scope, search },
    Boolean(statusQ.data) && !detailId
  )

  const auth = statusQ.error && /401|authoris|authoriz/i.test(String(statusQ.error.message || ''))
  const offline = gateway !== 'open'

  const openFile = file => {
    if (file.isFolder) {
      setTrail(prev => [...prev, { id: file.id, name: file.name }])
      setDetailId(null)
      setSearch('')
      setDraft('')

      return
    }

    setDetailId(file.id)
  }

  const jump = index => {
    setTrail(prev => (index < 0 ? [] : prev.slice(0, index + 1)))
    setDetailId(null)
  }

  const refresh = () => {
    statusQ.refetch()
    filesQ.refetch()
  }

  if (offline && !statusQ.data) {
    return jsx('div', {
      className: 'p-2',
      children: jsx(EmptyState, {
        className: 'min-h-32',
        description: 'The gateway socket is closed. It reconnects on its own — this pane follows.',
        title: 'Reconnecting to Hermes'
      })
    })
  }

  if (auth) {
    return jsx('div', {
      className: 'p-2',
      children: jsx(ErrorState, {
        description: 'This profile has no Google Drive grant in its google_token.json. Ask Sam to grant it — the consent click is yours.',
        title: 'Drive not authorised',
        children: jsx(Button, {
          className: 'mt-2',
          onClick: refresh,
          size: 'xs',
          type: 'button',
          variant: 'outline',
          children: 'Retry'
        })
      })
    })
  }

  const files = (filesQ.data && Array.isArray(filesQ.data.files) && filesQ.data.files) || []

  return jsxs('div', {
    className: 'relative flex h-full min-h-0 flex-col',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1 border-b border-(--ui-stroke-secondary) px-1.5 py-1',
        children: [
          jsx(StatusDot, { tone: statusQ.error ? 'bad' : statusQ.data ? 'good' : 'muted' }),
          jsx('span', {
            className: 'min-w-0 flex-1 truncate text-[0.65rem] text-(--ui-text-quaternary)',
            children: statusQ.data ? statusQ.data.account || 'Drive' : statusQ.isLoading ? 'Connecting…' : 'Drive'
          }),
          !search && scope === 'browse'
            ? jsx(Button, {
                disabled: upload.isPending,
                onClick: uploadHere,
                size: 'xs',
                title: `Upload a file into ${currentName(trail)}`,
                type: 'button',
                variant: 'ghost',
                children: jsx(Codicon, { name: upload.isPending ? 'loading' : 'cloud-upload', size: '0.85rem' })
              })
            : null,
          jsx(Button, {
            onClick: refresh,
            size: 'xs',
            title: 'Refresh',
            type: 'button',
            variant: 'ghost',
            children: jsx(Codicon, { name: 'refresh', size: '0.85rem' })
          })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1 px-1.5 pt-1',
        children: [
          jsx(SearchField, {
            onChange: value => {
              setDraft(value)

              if (!value) {
                setSearch('')
              }
            },
            onKeyDown: event => {
              if (event.key === 'Enter') {
                setSearch(draft.trim())
              }
            },
            placeholder: 'Search Drive (name or full text)',
            value: draft,
            variant: 'underline'
          }),
          jsx(SegmentedControl, {
            onChange: id => {
              setScope(id)
              setSearch('')
              setDraft('')
              setDetailId(null)

              if (id !== 'browse') {
                setTrail([])
              }
            },
            options: SCOPES,
            sizing: 'content',
            value: search ? 'browse' : scope
          }),
          search
            ? jsx('div', {
                className: 'flex items-center gap-1 px-1 text-[0.65rem] text-(--ui-text-quaternary)',
                children: [
                  jsx(Codicon, { name: 'search', size: '0.7rem' }),
                  jsx('span', { className: 'truncate', children: `results for “${search}”` }),
                  jsx('button', {
                    className: 'ml-auto text-(--ui-accent) hover:underline',
                    onClick: () => {
                      setSearch('')
                      setDraft('')
                    },
                    type: 'button',
                    children: 'clear'
                  })
                ]
              })
            : scope === 'browse'
              ? jsx(Breadcrumbs, { onJump: jump, trail })
              : null
        ]
      }),
      jsx('div', {
        className: 'min-h-0 flex-1 overflow-y-auto px-1.5 pt-1',
        children: detailId
          ? jsx(FileDetail, {
              ctx,
              fileId: detailId,
              onAsk: setAgentFile,
              onBack: () => setDetailId(null),
              onOpenFolder: folder => {
                setTrail(prev => {
                  const index = prev.findIndex(step => step.id === folder.id)

                  return index >= 0 ? prev.slice(0, index + 1) : [{ id: folder.id, name: folder.name }]
                })
                setDetailId(null)
              }
            })
          : filesQ.isLoading
            ? jsx('div', {
                className: 'flex items-center gap-2 p-2 text-xs text-(--ui-text-tertiary)',
                children: [jsx(GlyphSpinner, { key: 's' }), jsx('span', { key: 't', children: 'Listing…' })]
              })
            : filesQ.error
              ? jsx(ErrorState, {
                  description: errorText(filesQ.error),
                  title: 'Drive unavailable',
                  children: jsx(Button, {
                    className: 'mt-2',
                    onClick: refresh,
                    size: 'xs',
                    type: 'button',
                    variant: 'outline',
                    children: 'Retry'
                  })
                })
              : files.length
                ? jsx('div', {
                    className: 'flex flex-col pb-3',
                    children: files.map(file => jsx(FileRow, { file, onOpen: openFile }, file.id))
                  })
                : jsx(EmptyState, {
                    className: 'min-h-32',
                    description:
                      search || scope !== 'browse'
                        ? 'Nothing matched.'
                        : 'This folder is empty.',
                    title: 'Nothing here'
                  })
      }),
      agentFile
        ? jsx(AgentPicker, {
            onCancel: () => setAgentFile(null),
            onPick: async target => {
              const file = agentFile

              setAgentFile(null)
              await handToAgent(file, trail, target)
            },
            subtitle: agentFile.name
          })
        : null
    ]
  })
}

/* ------------------------------------------------------------------ */
/* settings page                                                      */
/* ------------------------------------------------------------------ */

function DriveSettings({ ctx }) {
  const statusQ = useStatus(ctx)
  const quota = (statusQ.data && statusQ.data.quota) || {}

  return jsxs('div', {
    className: 'flex flex-col gap-2 p-3 text-xs',
    children: [
      jsx('div', { className: 'font-medium', children: 'Google Drive pane' }),
      jsx('div', {
        className: 'text-(--ui-text-secondary)',
        children:
          'Read-only browser over this profile’s own Google grant: folders, recent, shared, starred, search and file metadata. Nothing is downloaded, moved or shared from here — the Ask agent handoff does that through gog-robert.'
      }),
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(StatusDot, { tone: statusQ.error ? 'bad' : statusQ.data ? 'good' : 'muted' }),
          jsx('span', {
            className: 'text-(--ui-text-secondary)',
            children: statusQ.data
              ? `Connected as ${statusQ.data.account || 'unknown'}${
                  quota.limit ? ` · ${humanSize(quota.usage)} of ${humanSize(quota.limit)} used` : ''
                }`
              : statusQ.isLoading
                ? 'Checking credentials…'
                : errorText(statusQ.error) || 'Not checked'
          })
        ]
      }),
      jsx(Button, {
        className: 'self-start',
        onClick: () => statusQ.refetch(),
        size: 'xs',
        type: 'button',
        variant: 'outline',
        children: 'Re-check'
      }),
      jsxs('div', {
        className: 'text-[0.65rem] text-(--ui-text-quaternary)',
        children: [
          'Token: ',
          jsx('code', { children: '$HERMES_HOME/google_token.json' }),
          ' for the active profile. The rclone mount at ~/GoogleDrive is the file-manager view of the same account.'
        ]
      })
    ]
  })
}

/* ------------------------------------------------------------------ */
/* registration                                                       */
/* ------------------------------------------------------------------ */

export default {
  id: ID,
  name: 'Drive',
  register(ctx) {
    ctx.register({
      area: 'panes',
      data: { placement: 'right', width: '360px' },
      id: 'pane',
      render: () => jsx(DrivePane, { ctx }),
      title: 'drive'
    })

    ctx.registerSettingsPage?.({
      icon: 'cloud',
      id: 'settings',
      render: () => jsx(DriveSettings, { ctx }),
      title: 'Drive'
    })
  }
}
