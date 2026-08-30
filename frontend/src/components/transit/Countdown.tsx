import { motion, useReducedMotion } from 'framer-motion'
import { cn } from '@/lib/utils'

/**
 * A visszaszámláló a tábla legnagyobb eleme — egy pillantással kiolvasható.
 * Percváltáskor a szám finoman felgördül: a mozgás azt közli, hogy
 * megváltozott az adat. Csökkentett mozgás mellett azonnal vált.
 */
export function Countdown({
  etaMin,
  size = 'lg',
  className,
}: {
  etaMin: number
  size?: 'md' | 'lg'
  className?: string
}) {
  const reduce = useReducedMotion()
  const arriving = etaMin <= 0

  return (
    <span
      className={cn('block shrink-0 text-right leading-none', className)}
      aria-label={arriving ? 'Beérkezik' : `${etaMin} perc múlva`}
    >
      <motion.span
        key={arriving ? 'now' : etaMin}
        initial={reduce ? false : { y: -8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="inline-block"
      >
        {arriving ? (
          /* Rövid szó, kis doboz: telefonon a hosszú „Beérkezik” felirat
             kiszorította a célállomás nevét. */
          <span
            className={cn(
              'inline-flex items-center rounded-md bg-primary px-2 py-1 font-extrabold uppercase tracking-wide text-primary-foreground',
              size === 'lg' ? 'text-sm sm:text-base' : 'text-xs sm:text-sm'
            )}
          >
            Most
          </span>
        ) : (
          <span className="font-mono font-bold tabular-nums text-foreground">
            {/* Telefonon kisebb, hogy ne szorítsa ki a célállomás nevét. */}
            <span className={size === 'lg' ? 'text-[32px] sm:text-[42px]' : 'text-xl sm:text-2xl'}>
              {etaMin}
            </span>
            <span className="ml-1 font-sans text-xs font-semibold text-muted-foreground sm:ml-1.5 sm:text-sm">
              perc
            </span>
          </span>
        )}
      </motion.span>
    </span>
  )
}
