open Core

type t =
  | Template_register of Workflow_template.t
  | Instance_register of Workflow_template.Instance.t
  | Budget_put of Run_budget.t
  | Usage_report of Usage_record.t
[@@deriving sexp]
