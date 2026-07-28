import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  children: ReactNode
}

const variants: Record<Variant, string> = {
  primary: 'bg-mustard text-ink',
  secondary: 'bg-sky text-ink',
  ghost: 'bg-paper text-ink',
  danger: 'bg-danger text-ink',
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg border-2 border-ink font-semibold',
        variants[variant],
        sizes[size],
        disabled
          ? 'cursor-not-allowed opacity-50 grayscale'
          : 'press shadow-hard cursor-pointer',
        className,
      )}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  )
}
