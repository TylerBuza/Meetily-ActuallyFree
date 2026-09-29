'use client';

/**
 * BlockNote draws its menus and tooltips inline, inside the editor, so near the
 * notes panel's edge they were clipped by the panel or drawn under the divider.
 * These are the app's own menu and tooltip components, rendered above the page
 * instead: menus into a layer at the top of the page that carries BlockNote's
 * container classes (so its theme variables and colour swatches still apply),
 * tooltips like every other tooltip in the app.
 */
import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Check } from 'lucide-react';
import type { BlockNoteView } from '@blocknote/shadcn';
import { cn } from '@/lib/utils';
import { TooltipProvider, tooltipMotion, tooltipSurface } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  menuItemClass,
} from '@/components/ui/dropdown-menu';

const LAYER_ID = 'af-blocknote-layer';
const LayerContext = React.createContext<HTMLElement | null>(null);

export const BlockNoteLayerProvider = LayerContext.Provider;

/** The shared layer for editor menus, kept in step with the light or dark theme. */
export function useBlockNoteLayer(dark: boolean): HTMLElement | null {
  const [layer, setLayer] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    let element = document.getElementById(LAYER_ID);
    if (!element) {
      element = document.createElement('div');
      element.id = LAYER_ID;
      element.className = 'bn-container bn-shadcn af-blocknote-layer';
      document.body.appendChild(element);
    }
    setLayer(element);
  }, []);
  React.useEffect(() => {
    if (!layer) return;
    layer.classList.toggle('dark', dark);
    layer.setAttribute('data-color-scheme', dark ? 'dark' : 'light');
  }, [layer, dark]);
  return layer;
}

/**
 * BlockNote freezes the + and drag handle while their menu is open and
 * unfreezes them when it closes. Radix reports the close from an effect, which
 * can run after the editor dropped that state (it reloads when a summary
 * arrives); BlockNote's unfreeze then throws and takes the page down. Nothing
 * is left to unfreeze in that case, so the error is dropped.
 */
function Root({ onOpenChange, ...props }: React.ComponentProps<typeof DropdownMenu>) {
  return (
    <DropdownMenu
      {...props}
      onOpenChange={(open) => {
        try {
          onOpenChange?.(open);
        } catch (error) {
          console.warn('[notes] block menu closed after its editor changed', error);
        }
      }}
    />
  );
}

const Content = React.forwardRef<
  React.ElementRef<typeof DropdownMenuContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuContent>
>((props, ref) => <DropdownMenuContent ref={ref} container={React.useContext(LayerContext)} {...props} />);
Content.displayName = 'BlockNoteMenuContent';

const SubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuSubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuSubContent>
>((props, ref) => <DropdownMenuSubContent ref={ref} container={React.useContext(LayerContext)} {...props} />);
SubContent.displayName = 'BlockNoteMenuSubContent';

/** BlockNote pads checked and unchecked rows differently; keep every row aligned, tick on the right. */
const CheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      menuItemClass,
      'pr-8',
      className
        ?.split(/\s+/)
        .filter((name) => !/^bn-(p[xylrtb]?|gap)-/.test(name))
        .join(' '),
    )}
    {...props}
  >
    {children}
    <span className="absolute right-2.5 flex h-4 w-4 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="!text-af-accent" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
  </DropdownMenuPrimitive.CheckboxItem>
));
CheckboxItem.displayName = 'BlockNoteMenuCheckboxItem';

/** Toolbar tooltips wait like the app's others instead of opening instantly. */
function ToolbarTooltipProvider({ children }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

/** Portaled, so the formatting toolbar's tooltips are never clipped. */
const ToolbarTooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      // BlockNote puts the action and its shortcut in two spans.
      className={cn(
        tooltipSurface,
        tooltipMotion,
        'flex flex-col items-center text-center [&>span+span]:mt-0.5 [&>span+span]:text-[11px] [&>span+span]:font-normal [&>span+span]:text-af-text-3',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
ToolbarTooltipContent.displayName = 'BlockNoteToolbarTooltipContent';

type ShadCNOverrides = NonNullable<React.ComponentProps<typeof BlockNoteView>['shadCNComponents']>;

/** Pass as `shadCNComponents` to BlockNoteView, inside a BlockNoteLayerProvider. */
export const blockNoteMenus = {
  DropdownMenu: {
    DropdownMenu: Root,
    DropdownMenuCheckboxItem: CheckboxItem,
    DropdownMenuContent: Content,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent: SubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
  },
  Tooltip: {
    Tooltip: TooltipPrimitive.Root,
    TooltipContent: ToolbarTooltipContent,
    TooltipProvider: ToolbarTooltipProvider,
    TooltipTrigger: TooltipPrimitive.Trigger,
  },
} as unknown as ShadCNOverrides;
