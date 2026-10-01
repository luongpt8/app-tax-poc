import { Button } from "@react-spectrum/s2/Button";
import { AlertDialog } from "@react-spectrum/s2/AlertDialog";
import { Content } from "@react-spectrum/s2/Content";
import { DialogTrigger } from "@react-spectrum/s2/Dialog";
import { Heading } from "@react-spectrum/s2/Heading";
import { IllustratedMessage } from "@react-spectrum/s2/IllustratedMessage";
import { InlineAlert } from "@react-spectrum/s2/InlineAlert";
import { ProgressCircle } from "@react-spectrum/s2/ProgressCircle";
import { space, style } from "@react-spectrum/s2/style" with { type: "macro" };
import {
  Cell,
  Column,
  Row,
  TableBody,
  TableHeader,
  TableView,
} from "@react-spectrum/s2/TableView";
import { Text } from "@react-spectrum/s2/Text";
import { useCallback, useState } from "react";

import { TaxClassDialogTrigger } from "../components/tax-class-dialog.tsx";
import { useDeleteCommerceTaxClass } from "../hooks/use-delete-commerce-tax-class.ts";
import { useGetCommerceTaxClasses } from "../hooks/use-get-commerce-tax-classes.ts";
import { useUpsertCommerceTaxClass } from "../hooks/use-upsert-commerce-tax-class.ts";

import type { TaxClass } from "../components/tax-class-dialog.tsx";

export function TaxClassesPage() {
  const {
    commerceTaxClasses,
    isLoadingCommerceTaxClasses,
    refetchCommerceTaxClasses,
  } = useGetCommerceTaxClasses();
  const upsertCommerceTaxClass = useUpsertCommerceTaxClass();
  const deleteCommerceTaxClass = useDeleteCommerceTaxClass();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleSave = useCallback(
    async (newTaxClass: TaxClass) => {
      // Let errors propagate so the dialog can keep itself open and show the message.
      await upsertCommerceTaxClass(newTaxClass);
      await refetchCommerceTaxClasses();
    },
    [upsertCommerceTaxClass, refetchCommerceTaxClasses],
  );

  const handleDelete = useCallback(
    async (classId: number) => {
      setDeleteError(null);
      try {
        await deleteCommerceTaxClass(classId);
        await refetchCommerceTaxClasses();
      } catch (error) {
        setDeleteError(
          error instanceof Error
            ? error.message
            : "Something went wrong while deleting the tax class.",
        );
      }
    },
    [deleteCommerceTaxClass, refetchCommerceTaxClasses],
  );

  const renderEmptyState = useCallback(
    () => (
      <IllustratedMessage>
        <Content>No data available</Content>
      </IllustratedMessage>
    ),
    [],
  );

  return (
    <main
      className={style({
        display: "flex",
        flexDirection: "column",
        marginX: 20,
      })}>
      <div
        className={style({
          alignItems: "center",
          display: "flex",
          flexDirection: "row",
          gap: 16,
          justifyContent: "space-between",
          marginX: space(5),
        })}>
        <Heading level={1}>Manage Tax Classes</Heading>

        <TaxClassDialogTrigger
          onSave={handleSave}
          taxClass={null}
          trigger={
            <Button variant="accent">Add New Tax Class</Button>
          }
        />
      </div>

      {deleteError && (
        <InlineAlert
          UNSAFE_style={{ marginBottom: 16 }}
          variant="negative">
          <Heading>Could not delete tax class</Heading>
          <Content>{deleteError}</Content>
        </InlineAlert>
      )}

      {isLoadingCommerceTaxClasses ? (
        <div
          className={style({
            alignItems: "center",
            display: "flex",
            height: "screen",
            justifyContent: "center",
          })}>
          <ProgressCircle aria-label="Loading…" isIndeterminate size="L" />
        </div>
      ) : (
        <div className={style({ display: "flex" })}>
          <TableView
            aria-label="tax class table"
            overflowMode="wrap"
            UNSAFE_style={{ flex: 1, minHeight: 400, width: "100%" }}>
            <TableHeader>
              <Column align="start" width={10}>
                #
              </Column>
              <Column>Commerce ID</Column>
              <Column>Class Type</Column>
              <Column isRowHeader>Class Name</Column>
              <Column>Custom Tax Code</Column>
              <Column>Actions</Column>
            </TableHeader>

            <TableBody
              items={commerceTaxClasses}
              renderEmptyState={renderEmptyState}>
              {(item) => (
                <Row key={item.id}>
                  <Cell>
                    <Text UNSAFE_style={{ color: "grey" }}>
                      {item.rowNumber}
                    </Text>
                  </Cell>
                  <Cell>{item.id}</Cell>
                  <Cell>{item.classType}</Cell>
                  <Cell>{item.className}</Cell>
                  <Cell>
                    {item.customTaxCode
                      ? `${item.customTaxCode} (${item.customTaxLabel})`
                      : ""}
                  </Cell>
                  <Cell>
                    <div
                      className={style({
                        display: "flex",
                        gap: 8,
                      })}>
                      <TaxClassDialogTrigger
                        key={item.id}
                        onSave={handleSave}
                        taxClass={item}
                        trigger={
                          <Button fillStyle="outline" variant="secondary">
                            Edit
                          </Button>
                        }
                      />
                      <DialogTrigger>
                        <Button fillStyle="outline" variant="negative">
                          Delete
                        </Button>
                        <AlertDialog
                          cancelLabel="Cancel"
                          onPrimaryAction={() => handleDelete(item.id)}
                          primaryActionLabel="Delete"
                          title="Delete Tax Class"
                          variant="destructive">
                          {`Are you sure you want to delete "${item.className}"? This cannot be undone.`}
                        </AlertDialog>
                      </DialogTrigger>
                    </div>
                  </Cell>
                </Row>
              )}
            </TableBody>
          </TableView>
        </div>
      )}
    </main>
  );
}
