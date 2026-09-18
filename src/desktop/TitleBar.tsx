import { CloudLogo } from '@/components/Avatar'
import { CompanySwitcher } from '@/components/CompanySwitcher'
import { isElectron, trafficLightInset } from '@/lib/runtime'
import { useT } from '@/lib/i18n'

export function TitleBar() {
  const t = useT()
  // In Electron with hidden titleBarStyle on mac, native traffic lights land in this strip.
  // Reserve space on the left for them, and make the bar a draggable region.
  const dragStyle = isElectron
    ? { WebkitAppRegion: 'drag' as const, userSelect: 'none' as const }
    : {}

  // Three equal-flex columns so the middle cell (and therefore the title)
  // is anchored to the WINDOW's horizontal center regardless of how wide
  // the left (traffic lights) or right (workspace switcher) cells happen
  // to be. The auto middle column shrinks to the title's intrinsic width,
  // so the 1fr cells on either side balance perfectly.
  const reservedLeft = Math.max(84, trafficLightInset)
  return (
    <header
      className="grid items-center px-4 border-b border-ink-100"
      style={{
        height: 44,
        background: 'var(--chrome)',
        gridTemplateColumns: `1fr auto 1fr`,
        ...dragStyle,
      }}
    >
      {/* Native traffic lights live in this region on mac; Electron paints
          them over the cell, browsers have none. The cell keeps a fixed
          width so the centred title can't slide under them, and we never
          draw decorative controls — in a browser tab they would look like
          window chrome that does not work. */}
      <div style={{ minWidth: reservedLeft }} />
      <div className="flex items-center justify-center gap-2.5 font-display font-medium text-[14px] text-ink-700 tracking-wide whitespace-nowrap">
        <CloudLogo />
        <span>Cumora</span>
        <em className="font-normal text-ink-500" style={{ fontStyle: 'italic' }}>{t('common.titlebarTagline')}</em>
      </div>
      <div className="flex items-center justify-end pr-2">
        <CompanySwitcher />
      </div>
    </header>
  )
}
