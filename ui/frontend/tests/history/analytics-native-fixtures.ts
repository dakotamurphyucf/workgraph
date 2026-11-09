// Synthetic records captured from an actual isolated daemon/socket; quantities remain strings.
export const nativeResponses = [
  {
    label: "search-empty",
    method: "history.search",
    params: {
      workspace_id: "demo",
      text: "needle",
      head: null,
    },
    response: {
      data: {
        coverage: [],
        has_more: false,
        index_complete: true,
        items: [],
        next: null,
        omitted_for_budget: "0",
        restart_after_indexing: false,
        unindexed_events: "0",
        unsearchable_events: "0",
      },
      meta: {
        history_capture: {
          head: null,
          sequence: "0",
          sessions: [],
          workspace_id: "demo",
        },
      },
    },
  },
  {
    label: "search-budget",
    method: "history.search",
    params: {
      workspace_id: "demo",
      text: "needle",
      session_id: "a-history",
      limit: "25",
      max_bytes: "4096",
    },
    response: {
      data: {
        coverage: [
          {
            committed_through: "35",
            indexed_through: "35",
            session_id: "a-history",
          },
          {
            committed_through: "0",
            indexed_through: "0",
            session_id: "b-history",
          },
          {
            committed_through: "1",
            indexed_through: "1",
            session_id: "generic",
          },
        ],
        has_more: true,
        index_complete: true,
        items: [
          {
            byte_offset: "602",
            event_ref: {
              sequence: "1",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "602",
            event_ref: {
              sequence: "2",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "602",
            event_ref: {
              sequence: "3",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "602",
            event_ref: {
              sequence: "4",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "602",
            event_ref: {
              sequence: "5",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
        ],
        next: {
          sequence: "5",
          session_id: "a-history",
        },
        omitted_for_budget: "1",
        restart_after_indexing: false,
        unindexed_events: "0",
        unsearchable_events: "0",
      },
      meta: {
        history_capture: {
          head: "968c01ae31f8cd3e8d1d6a0e1b5ea856309420f70668880fb45b2188cb958c04",
          sequence: "5",
          sessions: [
            {
              session_id: "a-history",
              through: "35",
            },
            {
              session_id: "b-history",
              through: "0",
            },
            {
              session_id: "generic",
              through: "1",
            },
          ],
          workspace_id: "demo",
        },
      },
    },
  },
  {
    label: "search-first",
    method: "history.search",
    params: {
      workspace_id: "demo",
      text: "needle",
      session_id: "a-history",
      limit: "25",
    },
    response: {
      data: {
        coverage: [
          {
            committed_through: "35",
            indexed_through: "35",
            session_id: "a-history",
          },
          {
            committed_through: "0",
            indexed_through: "0",
            session_id: "b-history",
          },
          {
            committed_through: "1",
            indexed_through: "1",
            session_id: "generic",
          },
        ],
        has_more: true,
        index_complete: true,
        items: [
          {
            byte_offset: "602",
            event_ref: {
              sequence: "1",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "602",
            event_ref: {
              sequence: "2",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "602",
            event_ref: {
              sequence: "3",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "602",
            event_ref: {
              sequence: "4",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "602",
            event_ref: {
              sequence: "5",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "602",
            event_ref: {
              sequence: "6",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "602",
            event_ref: {
              sequence: "7",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "602",
            event_ref: {
              sequence: "8",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "602",
            event_ref: {
              sequence: "9",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "10",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "11",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "12",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "13",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "14",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "15",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "16",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "17",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "18",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "19",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "20",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "21",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "22",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "23",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "24",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "25",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
        ],
        next: {
          sequence: "25",
          session_id: "a-history",
        },
        omitted_for_budget: "0",
        restart_after_indexing: false,
        unindexed_events: "0",
        unsearchable_events: "0",
      },
      meta: {
        history_capture: {
          head: "968c01ae31f8cd3e8d1d6a0e1b5ea856309420f70668880fb45b2188cb958c04",
          sequence: "5",
          sessions: [
            {
              session_id: "a-history",
              through: "35",
            },
            {
              session_id: "b-history",
              through: "0",
            },
            {
              session_id: "generic",
              through: "1",
            },
          ],
          workspace_id: "demo",
        },
      },
    },
  },
  {
    label: "search-next",
    method: "history.search",
    params: {
      workspace_id: "demo",
      text: "needle",
      session_id: "a-history",
      limit: "25",
      head: "968c01ae31f8cd3e8d1d6a0e1b5ea856309420f70668880fb45b2188cb958c04",
      after_event: {
        sequence: "25",
        session_id: "a-history",
      },
    },
    response: {
      data: {
        coverage: [
          {
            committed_through: "35",
            indexed_through: "35",
            session_id: "a-history",
          },
          {
            committed_through: "0",
            indexed_through: "0",
            session_id: "b-history",
          },
          {
            committed_through: "1",
            indexed_through: "1",
            session_id: "generic",
          },
        ],
        has_more: false,
        index_complete: true,
        items: [
          {
            byte_offset: "603",
            event_ref: {
              sequence: "26",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "27",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "28",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "29",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "30",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "31",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "32",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "33",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "34",
              session_id: "a-history",
            },
            kind: "message",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
          {
            byte_offset: "603",
            event_ref: {
              sequence: "35",
              session_id: "a-history",
            },
            kind: "measurement",
            role: "sensor",
            snippet:
              "e noise noise noise noise noise noise noise noise noise noise noise noise noise needle source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source source sourc",
          },
        ],
        next: null,
        omitted_for_budget: "0",
        restart_after_indexing: false,
        unindexed_events: "0",
        unsearchable_events: "0",
      },
      meta: {
        history_capture: {
          head: "968c01ae31f8cd3e8d1d6a0e1b5ea856309420f70668880fb45b2188cb958c04",
          sequence: "5",
          sessions: [
            {
              session_id: "a-history",
              through: "35",
            },
            {
              session_id: "b-history",
              through: "0",
            },
            {
              session_id: "generic",
              through: "1",
            },
          ],
          workspace_id: "demo",
        },
      },
    },
  },
  {
    label: "search-no-matches",
    method: "history.search",
    params: {
      workspace_id: "demo",
      text: "absent",
      session_id: "a-history",
    },
    response: {
      data: {
        coverage: [
          {
            committed_through: "36",
            indexed_through: "36",
            session_id: "a-history",
          },
          {
            committed_through: "0",
            indexed_through: "0",
            session_id: "b-history",
          },
          {
            committed_through: "1",
            indexed_through: "1",
            session_id: "generic",
          },
        ],
        has_more: false,
        index_complete: true,
        items: [],
        next: null,
        omitted_for_budget: "0",
        restart_after_indexing: false,
        unindexed_events: "0",
        unsearchable_events: "0",
      },
      meta: {
        history_capture: {
          head: "ba92dc903b4ff6bbe26caf8bf5d8e2d9484303991bd29aca22676c79f6380ef3",
          sequence: "6",
          sessions: [
            {
              session_id: "a-history",
              through: "36",
            },
            {
              session_id: "b-history",
              through: "0",
            },
            {
              session_id: "generic",
              through: "1",
            },
          ],
          workspace_id: "demo",
        },
      },
    },
  },
  {
    label: "usage-list",
    method: "usage.list",
    params: {
      workspace_id: "demo",
      limit: "2",
    },
    response: {
      data: {
        items: [
          {
            actor_id: "fixture-author",
            elapsed_ms: "0",
            metrics: [
              {
                name: "metric000_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric001_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric002_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric003_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric004_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric005_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric006_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric007_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric008_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric009_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric010_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric011_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric012_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric013_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric014_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric015_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
            ],
            provenance: "Synthetic externally reported source",
            scope: {
              kind: "run",
              run_id: "shared-run",
            },
            timestamp: "caller text: time unavailable",
            tokens: "0",
            usage_id: "many-0",
          },
          {
            actor_id: "fixture-author",
            elapsed_ms: "0",
            metrics: [
              {
                name: "metric016_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric017_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric018_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric019_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric020_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric021_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric022_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric023_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric024_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric025_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric026_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric027_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric028_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric029_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric030_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric031_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
            ],
            provenance: "Synthetic externally reported source",
            scope: {
              kind: "run",
              run_id: "shared-run",
            },
            timestamp: "caller text: time unavailable",
            tokens: "0",
            usage_id: "many-1",
          },
        ],
        next_offset: "2",
        omitted: "5",
      },
      meta: {
        query_revision: "7",
        query_scope: "policy",
      },
    },
  },
  {
    label: "usage-list-next",
    method: "usage.list",
    params: {
      workspace_id: "demo",
      limit: "2",
      offset: "2",
      expected_revision: "7",
    },
    response: {
      data: {
        items: [
          {
            actor_id: "fixture-author",
            elapsed_ms: "0",
            metrics: [
              {
                name: "metric032_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric033_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric034_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric035_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric036_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric037_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric038_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric039_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric040_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric041_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric042_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric043_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric044_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric045_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric046_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric047_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
            ],
            provenance: "Synthetic externally reported source",
            scope: {
              kind: "run",
              run_id: "shared-run",
            },
            timestamp: "caller text: time unavailable",
            tokens: "0",
            usage_id: "many-2",
          },
          {
            actor_id: "fixture-author",
            elapsed_ms: "0",
            metrics: [
              {
                name: "metric048_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric049_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric050_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric051_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric052_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric053_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric054_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric055_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric056_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric057_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric058_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric059_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric060_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric061_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric062_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric063_______________________________________________________",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
            ],
            provenance: "Synthetic externally reported source",
            scope: {
              kind: "run",
              run_id: "shared-run",
            },
            timestamp: "caller text: time unavailable",
            tokens: "0",
            usage_id: "many-3",
          },
        ],
        next_offset: "4",
        omitted: "3",
      },
      meta: {
        query_revision: "7",
        query_scope: "policy",
      },
    },
  },
  {
    label: "usage-rows",
    method: "usage.aggregate",
    params: {
      workspace_id: "demo",
      group_by: "run",
      metrics_layout: "rows",
      limit: "100",
    },
    response: {
      data: {
        basis: "externally_reported",
        cursor: null,
        group_by: "run",
        has_more: false,
        items: [
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "usage",
            totals: {
              elapsed_ms: "9007199254740998",
              metric_overflow: true,
              metric_series: "66",
              observations: "7",
              overflow: true,
              tokens: "9223372036854775807",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "bytes",
              overflow: false,
              samples: "1",
              unit: "KiB",
              value: "7",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "bytes",
              overflow: true,
              samples: "2",
              unit: "bytes",
              value: "9223372036854775807",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric000_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric001_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric002_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric003_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric004_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric005_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric006_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric007_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric008_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric009_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric010_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric011_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric012_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric013_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric014_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric015_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric016_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric017_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric018_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric019_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric020_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric021_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric022_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric023_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric024_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric025_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric026_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric027_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric028_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric029_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric030_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric031_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric032_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric033_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric034_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric035_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric036_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric037_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric038_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric039_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric040_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric041_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric042_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric043_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric044_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric045_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric046_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric047_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric048_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric049_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric050_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric051_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric052_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric053_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric054_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric055_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric056_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric057_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric058_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric059_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric060_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric061_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric062_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "metric",
            metric: {
              name: "metric063_______________________________________________________",
              overflow: false,
              samples: "1",
              unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
              value: "1",
            },
          },
        ],
        membership_basis: "current_capture",
        metrics_layout: "rows",
        needs_larger_budget: false,
        required_bytes: null,
        totals: {
          elapsed_ms: "9007199254740998",
          metric_overflow: true,
          metric_series: "66",
          observations: "7",
          overflow: true,
          tokens: "9223372036854775807",
        },
        unassigned_in_totals: true,
        unassigned_run_usage: {
          elapsed_ms: "9007199254740993",
          metric_overflow: true,
          metric_series: "65",
          observations: "6",
          overflow: true,
          tokens: "9223372036854775807",
        },
        unassigned_scope: "run_and_actor_filters",
      },
      meta: {
        budget: {
          details: [],
          details_complete: true,
          max_bytes: "65536",
          omitted_fields: "0",
          omitted_items: "0",
          returned_bytes: "16223",
          truncated: false,
        },
        workspace_revision: "21",
      },
    },
  },
  {
    label: "usage-nested",
    method: "usage.aggregate",
    params: {
      workspace_id: "demo",
      group_by: "run",
      metrics_layout: "nested",
      limit: "100",
    },
    response: {
      data: {
        basis: "externally_reported",
        cursor: null,
        group_by: "run",
        has_more: false,
        items: [
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "usage",
            metrics: [
              {
                name: "bytes",
                overflow: false,
                samples: "1",
                unit: "KiB",
                value: "7",
              },
              {
                name: "bytes",
                overflow: true,
                samples: "2",
                unit: "bytes",
                value: "9223372036854775807",
              },
              {
                name: "metric000_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric001_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric002_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric003_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric004_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric005_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric006_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric007_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric008_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric009_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric010_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric011_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric012_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric013_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric014_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric015_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric016_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric017_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric018_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric019_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric020_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric021_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric022_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric023_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric024_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric025_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric026_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric027_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric028_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric029_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric030_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric031_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric032_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric033_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric034_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric035_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric036_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric037_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric038_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric039_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric040_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric041_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric042_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric043_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric044_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric045_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric046_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric047_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric048_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric049_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric050_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric051_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric052_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric053_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric054_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric055_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric056_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric057_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric058_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric059_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric060_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric061_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric062_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric063_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
            ],
            totals: {
              elapsed_ms: "9007199254740998",
              metric_overflow: true,
              metric_series: "66",
              observations: "7",
              overflow: true,
              tokens: "9223372036854775807",
            },
          },
        ],
        membership_basis: "current_capture",
        metrics_layout: "nested",
        needs_larger_budget: false,
        required_bytes: null,
        totals: {
          elapsed_ms: "9007199254740998",
          metric_overflow: true,
          metric_series: "66",
          observations: "7",
          overflow: true,
          tokens: "9223372036854775807",
        },
        unassigned_in_totals: true,
        unassigned_run_usage: {
          elapsed_ms: "9007199254740993",
          metric_overflow: true,
          metric_series: "65",
          observations: "6",
          overflow: true,
          tokens: "9223372036854775807",
        },
        unassigned_scope: "run_and_actor_filters",
      },
      meta: {
        budget: {
          details: [],
          details_complete: true,
          max_bytes: "65536",
          omitted_fields: "0",
          omitted_items: "0",
          returned_bytes: "11485",
          truncated: false,
        },
        workspace_revision: "21",
      },
    },
  },
  {
    label: "usage-totals_only",
    method: "usage.aggregate",
    params: {
      workspace_id: "demo",
      group_by: "run",
      metrics_layout: "totals_only",
      limit: "100",
    },
    response: {
      data: {
        basis: "externally_reported",
        cursor: null,
        group_by: "run",
        has_more: false,
        items: [
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "usage",
            totals: {
              elapsed_ms: "9007199254740998",
              metric_overflow: true,
              metric_series: "66",
              observations: "7",
              overflow: true,
              tokens: "9223372036854775807",
            },
          },
        ],
        membership_basis: "current_capture",
        metrics_layout: "totals_only",
        needs_larger_budget: false,
        required_bytes: null,
        totals: {
          elapsed_ms: "9007199254740998",
          metric_overflow: true,
          metric_series: "66",
          observations: "7",
          overflow: true,
          tokens: "9223372036854775807",
        },
        unassigned_in_totals: true,
        unassigned_run_usage: {
          elapsed_ms: "9007199254740993",
          metric_overflow: true,
          metric_series: "65",
          observations: "6",
          overflow: true,
          tokens: "9223372036854775807",
        },
        unassigned_scope: "run_and_actor_filters",
      },
      meta: {
        budget: {
          details: [],
          details_complete: true,
          max_bytes: "65536",
          omitted_fields: "0",
          omitted_items: "0",
          returned_bytes: "1008",
          truncated: false,
        },
        workspace_revision: "21",
      },
    },
  },
  {
    label: "usage-project",
    method: "usage.aggregate",
    params: {
      workspace_id: "demo",
      group_by: "project",
      project_id: "release",
      metrics_layout: "nested",
    },
    response: {
      data: {
        basis: "externally_reported",
        cursor: null,
        group_by: "project",
        has_more: false,
        items: [
          {
            group: {
              kind: "project",
              project_id: "release",
            },
            kind: "usage",
            metrics: [
              {
                name: "bytes",
                overflow: false,
                samples: "1",
                unit: "KiB",
                value: "7",
              },
            ],
            totals: {
              elapsed_ms: "5",
              metric_overflow: false,
              metric_series: "1",
              observations: "1",
              overflow: false,
              tokens: "0",
            },
          },
        ],
        membership_basis: "current_capture",
        metrics_layout: "nested",
        needs_larger_budget: false,
        required_bytes: null,
        totals: {
          elapsed_ms: "5",
          metric_overflow: false,
          metric_series: "1",
          observations: "1",
          overflow: false,
          tokens: "0",
        },
        unassigned_in_totals: false,
        unassigned_run_usage: {
          elapsed_ms: "9007199254740993",
          metric_overflow: true,
          metric_series: "65",
          observations: "6",
          overflow: true,
          tokens: "9223372036854775807",
        },
        unassigned_scope: "run_and_actor_filters",
      },
      meta: {
        budget: {
          details: [],
          details_complete: true,
          max_bytes: "65536",
          omitted_fields: "0",
          omitted_items: "0",
          returned_bytes: "1034",
          truncated: false,
        },
        workspace_revision: "21",
      },
    },
  },
  {
    label: "usage-budget",
    method: "usage.aggregate",
    params: {
      workspace_id: "demo",
      group_by: "run",
      metrics_layout: "nested",
      limit: "1",
      max_bytes: "4096",
    },
    response: {
      data: {
        basis: "externally_reported",
        cursor:
          "eyJjaGVja3N1bSI6ImZkOTQyMTliMzE5M2M0MTQ3M2Y4MDkyZjg5ODA5MDMxZjJkM2I3MmE1YjkzMTJkZDhiMWY1MzJmMGIwNGRjYWYiLCJwYXlsb2FkIjp7ImFuY2hvciI6IjBhZGZlMWJjOTRiZDRiYmRlOTA1ZmU0ZGFlOGNiM2MxN2YxN2E0MWNlODZiMjYwODEyNzc2NjA4Y2FkZjI4OTEiLCJmaWx0ZXIiOiJmNDdhYmFmZDU2NWU1YjBlMjNlMDE5MjAzMDg3ZmM4OWRjMmFmZjAyODg5NjUxNTJhODQ2ZTVkMThiZWU2YmFjIiwib2Zmc2V0IjoiMCIsInJldmlzaW9uIjoiMjEiLCJ3b3Jrc3BhY2UiOiJkZW1vIn19",
        group_by: "run",
        has_more: true,
        items: [],
        membership_basis: "current_capture",
        metrics_layout: "nested",
        needs_larger_budget: true,
        required_bytes: "11485",
        totals: {
          elapsed_ms: "9007199254740998",
          metric_overflow: true,
          metric_series: "66",
          observations: "7",
          overflow: true,
          tokens: "9223372036854775807",
        },
        unassigned_in_totals: true,
        unassigned_run_usage: {
          elapsed_ms: "9007199254740993",
          metric_overflow: true,
          metric_series: "65",
          observations: "6",
          overflow: true,
          tokens: "9223372036854775807",
        },
        unassigned_scope: "run_and_actor_filters",
      },
      meta: {
        budget: {
          details: [
            {
              kind: "items",
              omitted: "1",
              path: "/items",
            },
          ],
          details_complete: true,
          max_bytes: "4096",
          omitted_fields: "0",
          omitted_items: "1",
          returned_bytes: "1220",
          truncated: true,
        },
        workspace_revision: "21",
      },
    },
  },
  {
    label: "usage-budget-retry",
    method: "usage.aggregate",
    params: {
      workspace_id: "demo",
      group_by: "run",
      metrics_layout: "nested",
      limit: "1",
      max_bytes: "11485",
      cursor:
        "eyJjaGVja3N1bSI6ImZkOTQyMTliMzE5M2M0MTQ3M2Y4MDkyZjg5ODA5MDMxZjJkM2I3MmE1YjkzMTJkZDhiMWY1MzJmMGIwNGRjYWYiLCJwYXlsb2FkIjp7ImFuY2hvciI6IjBhZGZlMWJjOTRiZDRiYmRlOTA1ZmU0ZGFlOGNiM2MxN2YxN2E0MWNlODZiMjYwODEyNzc2NjA4Y2FkZjI4OTEiLCJmaWx0ZXIiOiJmNDdhYmFmZDU2NWU1YjBlMjNlMDE5MjAzMDg3ZmM4OWRjMmFmZjAyODg5NjUxNTJhODQ2ZTVkMThiZWU2YmFjIiwib2Zmc2V0IjoiMCIsInJldmlzaW9uIjoiMjEiLCJ3b3Jrc3BhY2UiOiJkZW1vIn19",
      at_revision: "21",
    },
    response: {
      data: {
        basis: "externally_reported",
        cursor: null,
        group_by: "run",
        has_more: false,
        items: [
          {
            group: {
              kind: "run",
              run_id: "shared-run",
            },
            kind: "usage",
            metrics: [
              {
                name: "bytes",
                overflow: false,
                samples: "1",
                unit: "KiB",
                value: "7",
              },
              {
                name: "bytes",
                overflow: true,
                samples: "2",
                unit: "bytes",
                value: "9223372036854775807",
              },
              {
                name: "metric000_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric001_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric002_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric003_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric004_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric005_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric006_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric007_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric008_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric009_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric010_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric011_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric012_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric013_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric014_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric015_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric016_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric017_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric018_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric019_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric020_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric021_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric022_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric023_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric024_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric025_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric026_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric027_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric028_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric029_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric030_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric031_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric032_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric033_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric034_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric035_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric036_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric037_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric038_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric039_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric040_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric041_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric042_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric043_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric044_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric045_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric046_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric047_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric048_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric049_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric050_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric051_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric052_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric053_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric054_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric055_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric056_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric057_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric058_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric059_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric060_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric061_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric062_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
              {
                name: "metric063_______________________________________________________",
                overflow: false,
                samples: "1",
                unit: "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
                value: "1",
              },
            ],
            totals: {
              elapsed_ms: "9007199254740998",
              metric_overflow: true,
              metric_series: "66",
              observations: "7",
              overflow: true,
              tokens: "9223372036854775807",
            },
          },
        ],
        membership_basis: "current_capture",
        metrics_layout: "nested",
        needs_larger_budget: false,
        required_bytes: null,
        totals: {
          elapsed_ms: "9007199254740998",
          metric_overflow: true,
          metric_series: "66",
          observations: "7",
          overflow: true,
          tokens: "9223372036854775807",
        },
        unassigned_in_totals: true,
        unassigned_run_usage: {
          elapsed_ms: "9007199254740993",
          metric_overflow: true,
          metric_series: "65",
          observations: "6",
          overflow: true,
          tokens: "9223372036854775807",
        },
        unassigned_scope: "run_and_actor_filters",
      },
      meta: {
        budget: {
          details: [],
          details_complete: true,
          max_bytes: "11485",
          omitted_fields: "0",
          omitted_items: "0",
          returned_bytes: "11485",
          truncated: false,
        },
        workspace_revision: "21",
      },
    },
  },
] as const;
