import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { ButtonHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefAttributes } from 'react';

export type AccessibleChoiceValue = string | number;

export interface AccessibleChoiceGroupOption<Value extends AccessibleChoiceValue = AccessibleChoiceValue> {
  id?: string | number;
  value: Value;
  shortcut?: string;
  disabled?: boolean;
}

export interface AccessibleChoiceGroupHandle {
  focusOption: (index: number) => void;
  focusActive: () => void;
}

export type AccessibleChoiceRadioProps = ButtonHTMLAttributes<HTMLButtonElement> &
  RefAttributes<HTMLButtonElement> & {
    type: 'button';
    role: 'radio';
    'aria-checked': boolean;
    tabIndex: number;
  };

export interface AccessibleChoiceRenderState<
  Option extends AccessibleChoiceGroupOption = AccessibleChoiceGroupOption,
> {
  option: Option;
  index: number;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  radioProps: AccessibleChoiceRadioProps;
}

export interface AccessibleChoiceGroupProps<
  Option extends AccessibleChoiceGroupOption = AccessibleChoiceGroupOption,
> {
  options: Option[];
  selectedValue: Option['value'] | null | undefined;
  onSelect: (value: Option['value'], option: Option, index: number) => void;
  children: (state: AccessibleChoiceRenderState<Option>) => ReactNode;
  groupLabel?: string;
  groupLabelledBy?: string;
  describedBy?: string;
  className?: string;
  disabled?: boolean;
  readOnly?: boolean;
  stopPropagationOnHandled?: boolean;
}

function getSelectedIndex<Option extends AccessibleChoiceGroupOption>(
  options: Option[],
  selectedValue: Option['value'] | null | undefined,
) {
  if (selectedValue == null) return -1;
  return options.findIndex((option) => option.value === selectedValue);
}

function clampIndex(index: number, length: number) {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function handled(event: ReactKeyboardEvent, stopPropagationOnHandled: boolean) {
  event.preventDefault();
  if (stopPropagationOnHandled) {
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation?.();
  }
}

export const AccessibleChoiceGroup = forwardRef<
  AccessibleChoiceGroupHandle,
  AccessibleChoiceGroupProps
>(function AccessibleChoiceGroup(
  {
    options,
    selectedValue,
    onSelect,
    children,
    groupLabel = 'Answer options',
    groupLabelledBy,
    describedBy,
    className,
    disabled = false,
    readOnly = false,
    stopPropagationOnHandled = true,
  },
  ref,
) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const initialSelected = getSelectedIndex(options, selectedValue);
  const [activeIndex, setActiveIndex] = useState(initialSelected >= 0 ? initialSelected : 0);

  useEffect(() => {
    const selectedIndex = getSelectedIndex(options, selectedValue);
    if (selectedIndex >= 0) setActiveIndex(selectedIndex);
  }, [options, selectedValue]);

  useEffect(() => {
    setActiveIndex((current) => clampIndex(current, options.length));
    optionRefs.current = optionRefs.current.slice(0, options.length);
  }, [options.length]);

  const focusOption = useCallback(
    (index: number) => {
      const next = clampIndex(index, options.length);
      setActiveIndex(next);
      optionRefs.current[next]?.focus();
    },
    [options.length],
  );

  const findMovableIndex = useCallback(
    (start: number, delta: number) => {
      if (options.length === 0) return 0;
      for (let step = 0; step < options.length; step += 1) {
        const candidate = (start + delta * step + options.length) % options.length;
        if (!options[candidate]?.disabled) return candidate;
      }
      return clampIndex(start, options.length);
    },
    [options],
  );

  const move = useCallback(
    (delta: number) => {
      if (options.length === 0) return;
      focusOption(findMovableIndex(activeIndex + delta, delta));
    },
    [activeIndex, findMovableIndex, focusOption, options.length],
  );

  const select = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || disabled || readOnly || option.disabled) return;
      setActiveIndex(index);
      onSelect(option.value, option, index);
    },
    [disabled, onSelect, options, readOnly],
  );

  useImperativeHandle(
    ref,
    () => ({
      focusOption,
      focusActive: () => focusOption(activeIndex),
    }),
    [activeIndex, focusOption],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowRight':
          handled(event, stopPropagationOnHandled);
          move(1);
          return;
        case 'ArrowUp':
        case 'ArrowLeft':
          handled(event, stopPropagationOnHandled);
          move(-1);
          return;
        case 'Home':
          handled(event, stopPropagationOnHandled);
          focusOption(findMovableIndex(0, 1));
          return;
        case 'End':
          handled(event, stopPropagationOnHandled);
          focusOption(findMovableIndex(options.length - 1, -1));
          return;
        case ' ':
        case 'Enter':
          handled(event, stopPropagationOnHandled);
          select(activeIndex);
          return;
        default: {
          const shortcutIndex = options.findIndex(
            (option) => option.shortcut?.toLowerCase() === event.key.toLowerCase(),
          );
          if (shortcutIndex >= 0) {
            handled(event, stopPropagationOnHandled);
            focusOption(shortcutIndex);
            select(shortcutIndex);
          }
        }
      }
    },
    [
      activeIndex,
      disabled,
      findMovableIndex,
      focusOption,
      move,
      options,
      select,
      stopPropagationOnHandled,
    ],
  );

  return (
    <div
      role="radiogroup"
      aria-label={groupLabelledBy ? undefined : groupLabel}
      aria-labelledby={groupLabelledBy}
      aria-describedby={describedBy}
      aria-disabled={disabled || readOnly || undefined}
      className={className}
      onKeyDown={handleKeyDown}
    >
      {options.map((option, index) => {
        const selected = selectedValue === option.value;
        const optionDisabled = disabled || !!option.disabled;
        const active = index === activeIndex;
        const radioProps: AccessibleChoiceRadioProps = {
          ref: (node) => {
            optionRefs.current[index] = node;
          },
          type: 'button',
          role: 'radio',
          'aria-checked': selected,
          'aria-disabled': readOnly || option.disabled || undefined,
          'aria-keyshortcuts': option.shortcut,
          tabIndex: active ? 0 : -1,
          disabled: optionDisabled,
          onClick: () => select(index),
          onFocus: () => setActiveIndex(index),
        };

        return children({
          option,
          index,
          selected,
          active,
          disabled: optionDisabled,
          radioProps,
        });
      })}
    </div>
  );
});

export default AccessibleChoiceGroup;
