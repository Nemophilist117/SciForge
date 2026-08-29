import { useEffect, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CloudIdentitySection } from './CloudIdentitySection.js'
import type { IdentityRendererProjection } from './projection.js'

export function IdentityOverlay(props: Readonly<{
  projection: IdentityRendererProjection
  onClose: () => void
}>): React.JSX.Element {
  const { t } = useTranslation('identity')
  const snapshot = useSyncExternalStore(props.projection.subscribe, props.projection.getSnapshot)

  useEffect(() => {
    void props.projection.load()
  }, [props.projection])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4"
      role="presentation"
    >
      <section
        className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-lg border border-border bg-background p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="identity-account-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="identity-account-title" className="text-base font-semibold">
              {t('accountTitle')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('accountNotice')}</p>
          </div>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-muted"
            aria-label={t('close')}
            title={t('close')}
            onClick={props.onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <CloudIdentitySection projection={props.projection} />

        {snapshot.error ? (
          <p role="alert" className="mt-3 whitespace-pre-wrap break-words text-sm text-destructive">
            {snapshot.error}
          </p>
        ) : null}
      </section>
    </div>
  )
}
