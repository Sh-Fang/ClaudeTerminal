// 浮层宿主：ctx 右键菜单 / modal 弹窗 / pickTabs 勾选弹窗 / confirm 弹窗 / 会话选择浮层，z 序由 styles.css 保证。
// ToastHost 单独导出：.toast 是 position:absolute（相对 .main），必须由 App 放进 .main 层级。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as RKeyboardEvent, MouseEvent as RMouseEvent } from 'react'
import {
  useOverlays,
  closeCtxMenu,
  closeModal,
  closePickTabs,
  closeSessionPicker,
  openSessionPicker,
  resolveConfirm,
  type ModalOpts,
  type PickItem,
  type PickOpts,
  type SessionPickerOpts
} from '../state/overlays'
import { escapeHtml, formatTs, srcLabel } from '../lib/format'
import { icon } from '../svg-icons'
import { t } from '../i18n'

// scrim 关闭手势：mousedown 与 click 都落在 scrim 自身才关闭，防止 modal 内选文字拖出被误判
function useScrimDismiss(onDismiss: () => void): {
  onMouseDown: (e: RMouseEvent<HTMLDivElement>) => void
  onClick: (e: RMouseEvent<HTMLDivElement>) => void
} {
  const downRef = useRef(false)
  return {
    onMouseDown: (e) => {
      downRef.current = e.target === e.currentTarget
    },
    onClick: (e) => {
      if (e.target === e.currentTarget && downRef.current) onDismiss()
      downRef.current = false
    }
  }
}

function CtxMenu() {
  const ctx = useOverlays((s) => s.ctx)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDocClick = (e: globalThis.MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.ctx')) closeCtxMenu()
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [])

  // 先显示以测尺寸，再夹进屏幕防溢出
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !ctx) return
    const pad = 8
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const lx = Math.min(Math.max(pad, ctx.x), vw - w - pad)
    const ly = Math.min(Math.max(pad, ctx.y), vh - h - pad)
    el.style.left = `${lx}px`
    el.style.top = `${ly}px`
  }, [ctx])

  return (
    <div
      className={'ctx' + (ctx ? ' open' : '')}
      id="ctx"
      ref={ref}
      style={ctx?.minWidth != null ? { minWidth: ctx.minWidth } : undefined}
    >
      {ctx?.items.map((it, i) => {
        if (it.sep) return <div key={i} className="ctx-sep" />
        if (it.eyebrow) return <div key={i} className="ctx-eyebrow">{it.eyebrow}</div>
        return (
          <div
            key={i}
            className={'ctx-item' + (it.danger ? ' danger' : '')}
            onClick={() => {
              closeCtxMenu()
              it.act?.()
            }}
          >
            <span className="ic" dangerouslySetInnerHTML={{ __html: it.icon ?? '' }} />
            <span>{it.label ?? ''}</span>
            {it.metaHtml != null && (
              <span className="ctx-meta" dangerouslySetInnerHTML={{ __html: it.metaHtml }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// 取路径最后一段作为默认分组名；磁盘根美化成「D 盘」，取不到回退空串
function basenameOfPath(p: string): string {
  const drive = /^([a-zA-Z]):[\\/]?$/.exec(p.trim())
  if (drive) return t('{0} 盘', drive[1].toUpperCase())
  const segs = p.split(/[\\/]+/).filter(Boolean)
  return segs[segs.length - 1] ?? ''
}

function ModalBody({ cfg }: { cfg: ModalOpts }) {
  // 自动按 cwd 末段填 name，直到用户手动改过 name 为止
  const [name, setName] = useState(() => {
    if (cfg.autoNameFromCwd && cfg.cwd) {
      const base = basenameOfPath(cfg.cwd)
      if (base) return base
    }
    return cfg.name
  })
  const [cwd, setCwd] = useState(cfg.cwd ?? '')
  const [tabName, setTabName] = useState(cfg.tabName ?? 'A')
  const [cc, setCc] = useState(cfg.ccChecked ?? true)
  const [picking, setPicking] = useState(false)
  const nameUserEditedRef = useRef(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const id = window.setTimeout(() => {
      nameRef.current?.focus()
      nameRef.current?.select()
    }, 0)
    return () => window.clearTimeout(id)
  }, [])

  const maybeSyncNameFromCwd = (cwdValue: string): void => {
    if (!cfg.autoNameFromCwd || nameUserEditedRef.current) return
    const base = basenameOfPath(cwdValue)
    if (base) setName(base)
  }

  const submit = (): void => {
    const v = {
      name: name.trim(),
      cwd: cfg.kind === 'new-group' || cfg.kind === 'new-tab' ? cwd.trim() : undefined,
      autoLaunchCC: cfg.kind === 'new-group' || cfg.kind === 'new-tab' ? cc : undefined,
      tabName: cfg.showTabName ? tabName.trim() : undefined
    }
    if (!v.name) {
      nameRef.current?.focus()
      return
    }
    closeModal()
    cfg.onOk(v)
  }

  const onKeyDown = (e: RKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') submit()
    else if (e.key === 'Escape') closeModal()
  }

  const pickCwd = (): void => {
    const cb = cfg.onPickCwd
    if (!cb) return
    setPicking(true)
    void cb(cwd)
      .then((picked) => {
        if (picked) {
          setCwd(picked)
          maybeSyncNameFromCwd(picked)
        }
      })
      .catch(() => {})
      .finally(() => {
        setPicking(false)
      })
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title">{cfg.title}</h2>
      <p className="sub" id="modal-sub">{cfg.sub}</p>
      <div className="field" id="modal-name-field">
        <label>{t('名称')}</label>
        <input
          id="modal-name"
          ref={nameRef}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={name}
          onChange={(e) => {
            nameUserEditedRef.current = true
            setName(e.target.value)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {/* cwd 字段：仅 cfg.cwd !== undefined 时可见（新建场景传 ''，重命名场景不传） */}
      <div className="field" id="modal-cwd-field" style={cfg.cwd !== undefined ? undefined : { display: 'none' }}>
        <label>{t('路径 (cwd)')}</label>
        <div className="row-with-btn">
          <input
            id="modal-cwd"
            className="mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={cwd}
            onChange={(e) => {
              setCwd(e.target.value)
              maybeSyncNameFromCwd(e.target.value)
            }}
            onKeyDown={onKeyDown}
          />
          <button
            id="modal-cwd-pick"
            className="btn btn-secondary"
            type="button"
            title={t('选择目录')}
            style={cfg.onPickCwd ? undefined : { display: 'none' }}
            disabled={picking}
            onClick={pickCwd}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span>{t('浏览')}</span>
          </button>
        </div>
      </div>
      {/* 首个标签名与 CC 开关相互独立，字段是否出现由调用方 showTabName 决定 */}
      <div className="field" id="modal-tabname-field" style={cfg.showTabName ? undefined : { display: 'none' }}>
        <label>{t('首个标签名')}</label>
        <input
          id="modal-tabname"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={tabName}
          onChange={(e) => setTabName(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="field-check" id="modal-cc-field" style={cfg.showCC ? undefined : { display: 'none' }}>
        <span className="fc-line">
          <input id="modal-cc" type="checkbox" checked={cc} onChange={(e) => setCc(e.target.checked)} />
          <span>
            {t('自动启动 Claude Code（首次绑定 UUID，之后')} <code>--resume</code>
            {t('）')}
          </span>
        </span>
      </div>
      <div className="actions">
        <button id="modal-cancel" className="btn btn-secondary" onClick={closeModal}>
          {t('取消')}
        </button>
        <button id="modal-ok" className="btn btn-primary" onClick={submit}>
          {cfg.okLabel ?? t('创建')}
        </button>
      </div>
    </div>
  )
}

function ModalDialog() {
  const modal = useOverlays((s) => s.modal)
  const seq = useOverlays((s) => s.modalSeq)
  const dismiss = useScrimDismiss(closeModal)
  return (
    <div id="scrim" className="scrim" hidden={!modal} {...dismiss}>
      {/* key=seq：每次 openModal 重置内部输入态 */}
      {modal ? <ModalBody key={seq} cfg={modal} /> : null}
    </div>
  )
}

// action 行（id 以 '__' 开头）：不参与全选/计数，提交时照常归入 selectedIds
function pkIsAction(it: PickItem): boolean {
  return it.id.startsWith('__')
}

function PickBody({ cfg }: { cfg: PickOpts }) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const m: Record<string, boolean> = {}
    for (const it of cfg.items) m[it.id] = it.defaultChecked !== false && !it.disabled
    return m
  })
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [toggles, setToggles] = useState<Record<string, boolean>>(() => {
    const m: Record<string, boolean> = {}
    for (const it of cfg.items) if (it.sideToggle) m[it.id] = it.sideToggle.defaultChecked
    return m
  })
  // 每行已指定的会话（id → {sessionId, 展示标题}），key=seq 重挂即清空
  const [sessChosen, setSessChosen] = useState<Record<string, { sid: string; title: string }>>({})

  const selectedIds = cfg.items.filter((it) => !it.disabled && checked[it.id]).map((it) => it.id)
  const totalReal = cfg.items.filter((it) => !it.disabled && !pkIsAction(it)).length
  const curReal = selectedIds.filter((id) => !id.startsWith('__')).length
  const curAll = selectedIds.length // ok 启用看的是总选中数（含 action 行）

  const toggleAll = (): void => {
    // 全选判定只看实条目；程序化改勾选不清 sessChosen
    const target = curReal < totalReal
    setChecked((prev) => {
      const n = { ...prev }
      for (const it of cfg.items) {
        if (it.disabled || pkIsAction(it)) continue
        n[it.id] = target
      }
      return n
    })
  }

  const cancel = (): void => {
    const cb = cfg.onCancel
    closePickTabs()
    cb?.()
  }

  const ok = (): void => {
    if (selectedIds.length === 0) return
    const inputsOut: Record<string, string> = {}
    const togglesOut: Record<string, boolean> = {}
    for (const it of cfg.items) {
      if (it.inputPlaceholder) inputsOut[it.id] = (inputs[it.id] ?? '').trim()
      if (it.sideToggle) togglesOut[it.id] = toggles[it.id] ?? it.sideToggle.defaultChecked
    }
    const cb = cfg.onOk
    closePickTabs()
    cb(selectedIds, inputsOut, togglesOut)
  }

  const renderRow = (it: PickItem) => {
    const chosen = sessChosen[it.id]
    // meta：会话可点时渲染成徽标按钮，否则普通静态文本；entries 上游已过滤为重命名过的会话
    const canPickSess = !!it.sessionPick && it.sessionPick.entries.length >= 1

    const onCheckChange = (nowChecked: boolean): void => {
      setChecked((prev) => ({ ...prev, [it.id]: nowChecked }))
      if (!nowChecked && canPickSess && sessChosen[it.id]) {
        setSessChosen((prev) => {
          const n = { ...prev }
          delete n[it.id]
          return n
        })
        it.sessionPick!.onPick(null)
      }
    }

    const onBadgeClick = (e: RMouseEvent<HTMLButtonElement>): void => {
      // 阻止 label 的隐式 toggle 与冒泡
      e.preventDefault()
      e.stopPropagation()
      const badge = e.currentTarget
      openSessionPicker({
        anchor: badge,
        entries: it.sessionPick!.entries,
        selectedId: sessChosen[it.id]?.sid,
        title: t('选择要恢复的会话'),
        onPick: (sid) => {
          const ent = it.sessionPick!.entries.find((x) => x.sessionId === sid)
          setSessChosen((prev) => ({ ...prev, [it.id]: { sid, title: ent?.title ?? sid.slice(0, 8) } }))
          setChecked((prev) => ({ ...prev, [it.id]: true }))
          it.sessionPick!.onPick(sid)
        },
        onClear: () => {
          setSessChosen((prev) => {
            const n = { ...prev }
            delete n[it.id]
            return n
          })
          it.sessionPick!.onPick(null) // 清除指定，仍按默认会话恢复该标签（不改勾选态）
        }
      })
    }

    const chosenFull = chosen?.title ?? ''
    const chosenShort = chosenFull.length > 14 ? chosenFull.slice(0, 14) + '…' : chosenFull

    const rowInner = (
      <>
        <input
          type="checkbox"
          data-pk-id={it.id}
          checked={!!checked[it.id]}
          disabled={!!it.disabled}
          onChange={(e) => onCheckChange(e.target.checked)}
        />
        {it.inputPlaceholder ? (
          <input
            type="text"
            className="pk-input"
            data-pk-input-id={it.id}
            placeholder={it.inputPlaceholder}
            autoComplete="off"
            spellCheck={false}
            value={inputs[it.id] ?? ''}
            onChange={(e) => {
              const v = e.target.value
              setInputs((prev) => ({ ...prev, [it.id]: v }))
              setChecked((prev) => ({ ...prev, [it.id]: v.trim().length > 0 }))
            }}
          />
        ) : (
          <span className="pk-label">{it.label}</span>
        )}
        {canPickSess ? (
          <button
            type="button"
            className={'pk-meta pk-sess-count' + (chosen ? ' chosen' : '')}
            data-pk-sess-id={it.id}
            title={chosen ? t('从「{0}」恢复', chosenFull) : t('选择要恢复的会话')}
            onClick={onBadgeClick}
          >
            {chosen ? `${t('从「{0}」恢复', chosenShort)} ▾` : `${it.meta ?? ''} ▾`}
          </button>
        ) : it.meta ? (
          <span className="pk-meta">{it.meta}</span>
        ) : null}
        {it.sideToggle ? (
          // 阻止冒泡：外层 <label> 会对主 checkbox 做隐式 toggle
          <label className="pk-side-toggle" title={it.sideToggle.title ?? ''} onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              data-pk-toggle-id={it.id}
              checked={toggles[it.id] ?? it.sideToggle.defaultChecked}
              onChange={(e) => {
                const v = e.target.checked
                setToggles((prev) => ({ ...prev, [it.id]: v }))
              }}
            />
            <span>{it.sideToggle.label}</span>
          </label>
        ) : null}
        {it.onDelete ? (
          <button
            type="button"
            className="pk-del"
            data-pk-del-id={it.id}
            title={it.deleteTitle ?? t('从保存里删除')}
            aria-label={t('删除')}
            onClick={(e) => {
              // 阻止 label 的隐式 toggle 与 row 的冒泡
              e.preventDefault()
              e.stopPropagation()
              it.onDelete?.()
            }}
            dangerouslySetInnerHTML={{ __html: icon('trash', { size: 13 }) }}
          />
        ) : null}
      </>
    )

    const rowClass = 'pk-row' + (it.disabled ? ' is-disabled' : '')
    const rowAction = pkIsAction(it) ? '1' : undefined
    // 含 inputPlaceholder 的行用 <div> 而非 <label>：点 input 会触发 label 隐式 toggle 干扰光标
    return it.inputPlaceholder ? (
      <div key={it.id} className={rowClass} data-row-action={rowAction}>
        {rowInner}
      </div>
    ) : (
      <label key={it.id} className={rowClass} data-row-action={rowAction}>
        {rowInner}
      </label>
    )
  }

  return (
    <div className="modal modal-pick">
      <h2 id="pk-title">{cfg.title}</h2>
      <p className="sub" id="pk-sub" style={cfg.sub ? undefined : { display: 'none' }}>
        {cfg.sub ?? ''}
      </p>
      <div className="pk-toolbar">
        <button id="pk-toggle-all" type="button" className="link-btn" disabled={totalReal === 0} onClick={toggleAll}>
          {totalReal > 0 && curReal === totalReal ? t('取消全选') : t('全选')}
        </button>
        <span id="pk-count" className="pk-count">
          {totalReal === 0 ? '' : t('已选 {0} / {1}', curReal, totalReal)}
        </span>
      </div>
      <div id="pk-list" className="pk-list">
        {cfg.items.map(renderRow)}
      </div>
      <div className="actions">
        <button id="pk-cancel" className="btn btn-secondary" onClick={cancel}>
          {t('取消')}
        </button>
        <button id="pk-ok" className="btn btn-primary" disabled={curAll === 0} onClick={ok}>
          {cfg.okLabel ?? t('确认')}
        </button>
      </div>
    </div>
  )
}

function PickDialog() {
  const pick = useOverlays((s) => s.pick)
  const seq = useOverlays((s) => s.pickSeq)
  const dismiss = useScrimDismiss(() => {
    const cb = useOverlays.getState().pick?.onCancel
    closePickTabs()
    cb?.()
  })
  return (
    <div id="pickScrim" className="scrim" hidden={!pick} {...dismiss}>
      {/* key=seq：openPickTabs 重复调用就地刷新并重置勾选态 */}
      {pick ? <PickBody key={seq} cfg={pick} /> : null}
    </div>
  )
}

function ConfirmDialog() {
  const cf = useOverlays((s) => s.confirm)
  const dismiss = useScrimDismiss(() => resolveConfirm(false))
  return (
    <div id="confirmScrim" className="scrim" hidden={!cf} {...dismiss}>
      <div className="modal modal-confirm">
        <h2 id="cf-title">{cf?.title ?? ''}</h2>
        {/* message 是调用方拼好的 HTML，调用方负责转义 */}
        <div className="cf-body" id="cf-msg" dangerouslySetInnerHTML={{ __html: cf?.message ?? '' }} />
        <div className="actions">
          <button id="cf-cancel" className="btn btn-secondary" onClick={() => resolveConfirm(false)}>
            {t('取消')}
          </button>
          <button
            id="cf-ok"
            className={`btn ${cf?.danger === false ? 'btn-primary' : 'btn-danger'}`}
            onClick={() => resolveConfirm(true)}
          >
            {cf?.okLabel ?? t('确认')}
          </button>
        </div>
      </div>
    </div>
  )
}

// 会话选择浮层：点「N 会话」徽标弹出的小列表，管理页与勾选弹窗两个恢复入口共用。
// 锚定在徽标下方，越界自动上翻/内收；外部点击 / Esc / 滚动即关闭。
function SessionPickerBody({ opts }: { opts: SessionPickerOpts }) {
  const ref = useRef<HTMLDivElement>(null)

  // 定位：锚点下方左对齐；放不下时选空间更大的一侧并把高度收进该侧可用高度
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    const r = opts.anchor.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const MARGIN = 8
    const GAP = 4
    const SAFE_TOP = 40 // 标题栏 32px + 余量：浮层不越过此线
    const spaceBelow = vh - r.bottom - GAP - MARGIN
    const spaceAbove = r.top - GAP - MARGIN - SAFE_TOP
    const placeBelow = spaceBelow >= spaceAbove
    const avail = Math.max(Math.floor(placeBelow ? spaceBelow : spaceAbove), 120)
    host.style.maxHeight = `${avail}px`
    const pw = host.offsetWidth
    const ph = host.offsetHeight
    let left = r.left
    if (left + pw > vw - MARGIN) left = Math.max(MARGIN, vw - MARGIN - pw)
    let top = placeBelow ? r.bottom + GAP : r.top - GAP - ph
    top = Math.max(SAFE_TOP, top)
    host.style.left = `${Math.round(left)}px`
    host.style.top = `${Math.round(top)}px`
  }, [opts])

  useEffect(() => {
    const host = ref.current
    if (!host) return
    const onDocDown = (e: globalThis.MouseEvent): void => {
      if (host.contains(e.target as Node) || opts.anchor.contains(e.target as Node)) return
      closeSessionPicker()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeSessionPicker()
      }
    }
    const onGone = (): void => closeSessionPicker()
    // 仅浮层外部滚动才关闭（外部滚动会让锚点移位）
    const onScroll = (e: Event): void => {
      if (host.contains(e.target as Node)) return
      closeSessionPicker()
    }
    // 延后挂 mousedown，避免打开的这次点击立即关掉它
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onGone, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onDocDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onGone, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [opts])

  return (
    <div className="sesspick" ref={ref}>
      {opts.title ? <div className="sesspick-head">{opts.title}</div> : null}
      {opts.entries.map((e) => {
        const sel = !!opts.selectedId && e.sessionId === opts.selectedId
        const meta = `${escapeHtml(formatTs(e.ts))} · <span class="src">${escapeHtml(srcLabel(e.source))}</span> · ${escapeHtml(e.sessionId.slice(0, 8))}${e.isDefault ? ` · <span class="cur">${t('默认')}</span>` : ''}`
        return (
          <div
            key={e.sessionId}
            className={`sesspick-item sess-item${e.isDefault ? ' current' : ''}${sel ? ' selected' : ''}`}
            onClick={() => {
              closeSessionPicker()
              opts.onPick(e.sessionId)
            }}
          >
            <span className="sdot"></span>
            <div className="sess-body">
              <div className="sess-title">{e.title}</div>
              <div className="sess-meta" dangerouslySetInnerHTML={{ __html: meta }} />
            </div>
          </div>
        )
      })}
      {opts.onClear ? (
        <div
          className="sesspick-item sesspick-clear"
          onClick={() => {
            const cb = opts.onClear
            closeSessionPicker()
            cb?.()
          }}
        >
          <div className="sess-body">
            <div className="sess-title">{t('用默认会话恢复')}</div>
            <div className="sess-meta">{t('清除指定，按标签原活跃会话')}</div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SessionPicker() {
  const sp = useOverlays((s) => s.sessPick)
  return sp ? <SessionPickerBody opts={sp} /> : null
}

// toast：隐藏时保留文字，让淡出动画期间内容不消失
export function ToastHost() {
  const msg = useOverlays((s) => s.toastMsg)
  const show = useOverlays((s) => s.toastShow)
  return (
    <div id="toast" className={'toast' + (show ? ' show' : '')}>
      <span id="toastMsg">{msg}</span>
    </div>
  )
}

export function OverlayHost() {
  return (
    <>
      <CtxMenu />
      <ModalDialog />
      <PickDialog />
      <ConfirmDialog />
      <SessionPicker />
    </>
  )
}
