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
      className={cn('block text-right leading-none', className)}
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
          <span
            className={cn(
              'inline-flex items-center rounded-lg bg-primary px-3 py-1.5 font-extrabold uppercase tracking-wide text-primary-foreground shadow-glow',
              size === 'lg' ? 'text-base' : 'text-sm'
            )}
          >
            Beérkezik
          </span>
        ) : (
          <span className="font-mono font-bold tabular-nums text-foreground">
            <span className={size === 'lg' ? 'text-[42px]' : 'text-2xl'}>{etaMin}</span>
            <span className="ml-1.5 font-sans text-sm font-semibold text-muted-foreground">
              perc
            </span>
          </span>
        )}
      </motion.span>
    </span>
  )
}
