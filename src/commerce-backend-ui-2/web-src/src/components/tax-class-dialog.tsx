import { Button, ButtonGroup } from "@react-spectrum/s2/ButtonGroup";
import { Content } from "@react-spectrum/s2/Content";
import { Dialog, DialogTrigger } from "@react-spectrum/s2/Dialog";
import { Form } from "@react-spectrum/s2/Form";
import { Heading } from "@react-spectrum/s2/Heading";
import { InlineAlert } from "@react-spectrum/s2/InlineAlert";
import { Picker, PickerItem } from "@react-spectrum/s2/Picker";
import { TextField } from "@react-spectrum/s2/TextField";
import { useCallback, useState } from "react";

import type { ReactElement } from "react";
import type { Key } from "react-aria-components";

export type TaxClass = {
  id?: number;
  className: string;
  customTaxCode: string;
  customTaxLabel: string;
  classType: string;
};

type UseTaxClassFormArgs = {
  taxClass: TaxClass | null;
  onSave: (taxClass: TaxClass) => Promise<void>;
};

// The third-party tax code/label sent alongside the tax class is derived straight from the
// class name (no separate code lookup), e.g. "Reduced Rate Goods" -> "REDUCED_RATE_GOODS".
function deriveTaxCode(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Dialog renders its `children` render-prop multiple times, once per internal layout region
// (header/content/footer), each a separate instantiation of whatever component that render-prop
// returns. Owning this state in a hook called by the component that renders <Dialog> itself (not
// by the render-prop's return value) keeps every region reading from the same source of truth.
function useTaxClassForm({ taxClass, onSave }: UseTaxClassFormArgs) {
  const [className, setClassName] = useState(taxClass?.className || "");
  const [classType, setClassType] = useState(taxClass?.classType || "PRODUCT");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleClassTypeChange = useCallback((key: Key | null) => {
    setClassType(String(key));
  }, []);

  const submit = useCallback(
    async (close: () => void) => {
      const trimmedName = className.trim();
      if (!trimmedName) {
        setFormError("Class Name is required.");
        return;
      }

      const taxCode = deriveTaxCode(trimmedName);
      if (!taxCode) {
        setFormError("Class Name must contain at least one letter or digit.");
        return;
      }

      setFormError(null);
      setIsSaving(true);
      try {
        await onSave({
          className: trimmedName,
          classType,
          customTaxCode: taxCode,
          customTaxLabel: trimmedName,
          id: taxClass?.id,
        });
        close();
      } catch (error) {
        setFormError(
          error instanceof Error
            ? error.message
            : "Something went wrong while saving the tax class.",
        );
      } finally {
        setIsSaving(false);
      }
    },
    [className, classType, onSave, taxClass?.id],
  );

  return {
    className,
    classType,
    formError,
    handleClassTypeChange,
    isSaving,
    setClassName,
    submit,
  };
}

type TaxClassDialogBodyProps = ReturnType<typeof useTaxClassForm> & {
  isEdit: boolean;
  close: () => void;
};

// Pure presentational dialog body: owns no state, so it behaves the same no matter how many
// times Dialog mounts it internally (see useTaxClassForm above for why that matters here).
function TaxClassDialogBody({
  isEdit,
  close,
  className,
  setClassName,
  classType,
  handleClassTypeChange,
  formError,
  isSaving,
  submit,
}: TaxClassDialogBodyProps) {
  const handleSubmit = useCallback(() => {
    submit(close);
  }, [submit, close]);

  return (
    <>
      <Heading slot="title">
        {isEdit ? "Edit Tax Class" : "Add New Tax Class"}
      </Heading>
      <Content>
        {formError && (
          <InlineAlert variant="negative">
            <Heading>{formError}</Heading>
          </InlineAlert>
        )}
        <Form>
          <TextField
            isRequired
            label="Class Name"
            onChange={setClassName}
            value={className}
          />
          <Picker
            isDisabled={isEdit}
            isRequired
            label="Class Type"
            onSelectionChange={handleClassTypeChange}
            selectedKey={classType}>
            <PickerItem id="PRODUCT">PRODUCT</PickerItem>
            <PickerItem id="SHIPPING">SHIPPING</PickerItem>
            <PickerItem id="CUSTOMER">CUSTOMER</PickerItem>
          </Picker>
        </Form>
      </Content>
      {/* Dialog only renders ButtonGroup in its footer slot when it's a direct child, not nested in Content/Form. */}
      <ButtonGroup align="end">
        <Button
          data-testid="tax-class-cancel-button"
          isDisabled={isSaving}
          onPress={close}
          variant="secondary">
          Cancel
        </Button>
        <Button
          data-testid="tax-class-save-button"
          isDisabled={isSaving}
          onPress={handleSubmit}
          variant="accent">
          {isSaving ? "Saving\u2026" : "Save"}
        </Button>
      </ButtonGroup>
    </>
  );
}

export type TaxClassDialogTriggerProps = {
  trigger: ReactElement;
  taxClass: TaxClass | null;
  onSave: (taxClass: TaxClass) => Promise<void>;
};

// Use this instead of composing <DialogTrigger>/<Dialog> directly: it owns the form state once,
// outside of Dialog's internal multi-region rendering, and threads it down as props.
export function TaxClassDialogTrigger({
  trigger,
  taxClass,
  onSave,
}: TaxClassDialogTriggerProps) {
  const form = useTaxClassForm({ onSave, taxClass });

  return (
    <DialogTrigger>
      {trigger}
      <Dialog>
        {({ close }) => (
          <TaxClassDialogBody {...form} close={close} isEdit={Boolean(taxClass)} />
        )}
      </Dialog>
    </DialogTrigger>
  );
}


