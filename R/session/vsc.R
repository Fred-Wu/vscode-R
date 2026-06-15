pid <- Sys.getpid()
wd <- getwd()
tempdir <- tempdir()
homedir <- Sys.getenv(
    if (.Platform$OS.type == "windows") "USERPROFILE" else "HOME"
)
dir_watcher <- Sys.getenv("VSCODE_WATCHER_DIR", file.path(homedir, ".vscode-R"))
request_file <- file.path(dir_watcher, "request.log")
request_lock_file <- file.path(dir_watcher, "request.lock")
settings_file <- file.path(dir_watcher, "settings.json")
user_options <- names(options())

logger <- if (getOption("vsc.debug", FALSE)) {
    function(...) cat(..., "\n", sep = "")
} else {
    function(...) invisible()
}

load_settings <- function() {
    if (!file.exists(settings_file)) {
        return(FALSE)
    }

    setting <- function(x, ...) {
        switch(EXPR = x, ..., x)
    }

    mapping <- quote(list(
        vsc.use_webserver = session$useWebServer,
        vsc.use_httpgd = plot$useHttpgd,
        vsc.show_object_size = workspaceViewer$showObjectSize,
        vsc.rstudioapi = session$emulateRStudioAPI,
        vsc.globalenv = session$watchGlobalEnvironment,
        vsc.plot = setting(session$viewers$viewColumn$plot, Disable = FALSE),
        vsc.dev.args = plot$devArgs,
        vsc.browser = setting(session$viewers$viewColumn$browser, Disable = FALSE),
        vsc.viewer = setting(session$viewers$viewColumn$viewer, Disable = FALSE),
        vsc.page_viewer = setting(session$viewers$viewColumn$pageViewer, Disable = FALSE),
        vsc.view = setting(session$viewers$viewColumn$view, Disable = FALSE),
        vsc.helpPanel = setting(session$viewers$viewColumn$helpPanel, Disable = FALSE)
    ))

    vsc_settings <- tryCatch(jsonlite::read_json(settings_file), error = function(e) {
        message("Error occurs when reading VS Code settings: ", conditionMessage(e))
    })

    if (is.null(vsc_settings)) {
        return(FALSE)
    }

    ops <- eval(mapping, vsc_settings)

    # exclude options set by user on startup
    r_options <- ops[!(names(ops) %in% user_options)]

    options(r_options)
}

load_settings()

if (is.null(getOption("help_type"))) {
    options(help_type = "html")
}

use_webserver <- isTRUE(getOption("vsc.use_webserver", FALSE)) ||
    isTRUE(getOption("vsc.globalenv", TRUE))

get_column_def <- function(name, field, value) {
    tooltip <- sprintf(
        "%s, class: [%s], type: %s",
        name,
        toString(class(value)),
        typeof(value)
    )
    if (is.numeric(value)) {
        type <- "numericColumn"
        filter <- "agNumberColumnFilter"
    } else if (inherits(value, "Date")
               || inherits(value, "POSIXct")
               || inherits(value, "POSIXlt")) {
        type <- "dateColumn"
        filter <- "agDateColumnFilter"
    } else if (is.logical(value)) {
        type <- "booleanColumn"
        filter <- "agNumberColumnFilter"
    } else {
        type <- "textColumn"
        filter <- "agTextColumnFilter"
    }
    list(
        headerName = name,
        headerTooltip = tooltip,
        field = field,
        type = type,
        filter = filter
    )
}

dataview_is_table <- function(data) {
    is.data.frame(data) || is.matrix(data) ||
        inherits(data, "ArrowTabular") ||
        inherits(data, "polars_data_frame")
}

dataview_schema <- function(data) {
    if (inherits(data, "ArrowTabular")) {
        return(data[0, ]$to_data_frame())
    }
    if (inherits(data, "polars_data_frame")) {
        return(as.data.frame(data[0, ]))
    }
    data[0, , drop = FALSE]
}

dataview_slice <- function(data, rows) {
    if (inherits(data, "ArrowTabular")) {
        if (!length(rows)) {
            return(data[0, ]$to_data_frame())
        }
        return(data[rows, ]$to_data_frame())
    }
    if (inherits(data, "polars_data_frame")) {
        return(as.data.frame(data[rows, ]))
    }
    data[rows, , drop = FALSE]
}

dataview_column <- function(data, position) {
    if (inherits(data, "ArrowTabular")) {
        return(as.vector(data[[position]]))
    }
    if (inherits(data, "polars_data_frame")) {
        return(as.data.frame(data[, position])[[1]])
    }
    if (is.matrix(data)) {
        return(data[, position])
    }
    data[[position]]
}

dataview_text_values <- function(values) {
    if (is.character(values) || is.factor(values)) {
        return(as.character(values))
    }
    if (is.list(values)) {
        return(vapply(values, function(value) {
            tryCatch(
                paste(format(value), collapse = " "),
                error = function(e) paste0("<", paste(class(value), collapse = ", "), ">")
            )
        }, character(1)))
    }
    tryCatch(
        as.character(values),
        error = function(e) {
            vapply(seq_along(values), function(index) {
                paste(format(values[index]), collapse = " ")
            }, character(1))
        }
    )
}

dataview_sort_values <- function(values) {
    if (is.list(values) && !inherits(values, "POSIXlt")) {
        return(dataview_text_values(values))
    }
    tryCatch({
        xtfrm(values)
        values
    }, error = function(e) dataview_text_values(values))
}

dataview_format_page <- function(page) {
    if (!is.data.frame(page)) {
        return(page)
    }
    for (position in seq_len(ncol(page))) {
        column <- page[[position]]
        if (is.list(column) &&
                !inherits(column, "POSIXlt")) {
            page[[position]] <- dataview_text_values(column)
        }
    }
    page
}

dataview_filter_condition <- function(values, condition) {
    op <- condition$type
    if (is.null(op)) {
        return(rep(TRUE, length(values)))
    }

    text_values <- NULL
    blank <- function() {
        if (is.character(values) || is.factor(values) || is.list(values)) {
            text_values <<- dataview_text_values(values)
            is.na(values) | text_values == ""
        } else {
            is.na(values)
        }
    }

    if (op == "blank") {
        return(blank())
    }
    if (op == "notBlank") {
        return(!blank())
    }

    if (inherits(values, "Date") ||
            inherits(values, "POSIXct") ||
            inherits(values, "POSIXlt")) {
        values <- as.Date(values)
        low <- as.Date(if (is.null(condition$dateFrom)) condition$filter else condition$dateFrom)
        high <- as.Date(if (is.null(condition$dateTo)) condition$filterTo else condition$dateTo)
    } else if (inherits(values, "integer64") &&
                   requireNamespace("bit64", quietly = TRUE)) {
        low <- bit64::as.integer64(as.character(condition$filter))
        high <- bit64::as.integer64(as.character(condition$filterTo))
    } else if (is.numeric(values) || is.logical(values)) {
        values <- as.numeric(values)
        low <- suppressWarnings(as.numeric(condition$filter))
        high <- suppressWarnings(as.numeric(condition$filterTo))
    } else {
        values <- tolower(dataview_text_values(values))
        low <- tolower(as.character(condition$filter))
        high <- NULL
    }

    result <- switch(op,
        equals             = values == low,
        notEqual           = values != low,
        greaterThan        = values > low,
        greaterThanOrEqual = values >= low,
        lessThan           = values < low,
        lessThanOrEqual    = values <= low,
        contains           = grepl(low, values, fixed = TRUE),
        notContains        = !grepl(low, values, fixed = TRUE),
        startsWith         = startsWith(values, low),
        endsWith           = endsWith(values, low),
        regexp             = grepl(low, values),
        inRange            = values >= low & values <= high,
        rep(TRUE, length(values))
    )
    result[is.na(result)] <- FALSE
    result
}

dataview_filter_values <- function(values, model) {
    conditions <- model$conditions
    if (is.null(conditions) && !is.null(model$condition1)) {
        conditions <- Filter(Negate(is.null), list(model$condition1, model$condition2))
    }
    if (is.null(conditions) || !length(conditions)) {
        return(dataview_filter_condition(values, model))
    }

    matches <- lapply(conditions, function(condition) {
        dataview_filter_condition(values, condition)
    })
    if (identical(toupper(model$operator), "OR")) {
        Reduce(`|`, matches)
    } else {
        Reduce(`&`, matches)
    }
}

dataview_field_position <- function(field, column_count) {
    position <- suppressWarnings(as.integer(sub("^x", "", field))) - 2L
    if (is.na(position) || position < 1L || position > column_count) {
        return(NA_integer_)
    }
    position
}

dataview_query_key <- function(sortModel, filterModel) {
    if (is.null(sortModel) || !length(sortModel)) {
        sortModel <- NULL
    }
    if (is.null(filterModel) || !length(filterModel)) {
        filterModel <- NULL
    }
    jsonlite::toJSON(
        list(sortModel = sortModel, filterModel = filterModel),
        auto_unbox = TRUE,
        null = "null",
        force = TRUE
    )
}

dataview_query_indices <- function(state, sortModel, filterModel) {
    row_indices <- NULL
    if (!is.null(filterModel) && length(filterModel)) {
        matches <- rep(TRUE, state$total_unfiltered)
        for (field in names(filterModel)) {
            position <- dataview_field_position(field, state$column_count)
            if (is.na(position)) {
                next
            }
            values <- dataview_column(state$data, position)
            matches <- matches & dataview_filter_values(values, filterModel[[field]])
        }
        row_indices <- which(matches)
    }

    if (!is.null(sortModel) && length(sortModel)) {
        if (is.null(row_indices)) {
            row_indices <- seq_len(state$total_unfiltered)
        }

        sort_values <- list()
        decreasing <- logical()
        for (sort_item in sortModel) {
            position <- dataview_field_position(sort_item$colId, state$column_count)
            if (is.na(position)) {
                next
            }
            values <- dataview_column(state$data, position)[row_indices]
            sort_values[[length(sort_values) + 1L]] <- dataview_sort_values(values)
            decreasing <- c(decreasing, identical(sort_item$sort, "desc"))
        }

        if (length(sort_values)) {
            # The source row index is the deterministic tie-breaker.
            sort_values[[length(sort_values) + 1L]] <- row_indices
            decreasing <- c(decreasing, FALSE)
            args <- c(sort_values, list(
                na.last = TRUE,
                decreasing = decreasing,
                method = "radix"
            ))
            row_indices <- row_indices[do.call(order, args)]
        }
    }

    row_indices
}

dataview_table <- local({
    cache <- new.env(parent = emptyenv())

    register <- function(data, key) {
        if (!dataview_is_table(data)) {
            stop("data must be a data frame, a matrix, an arrow table or a polars data frame.")
        }

        column_names <- colnames(data)
        if (is.null(column_names)) {
            column_names <- sprintf("V%d", seq_len(ncol(data)))
        } else {
            column_names <- trimws(column_names)
        }
        fields <- sprintf("x%d", seq_len(length(column_names) + 2L))
        full_names <- c("(row)", "rowId", column_names)
        schema <- dataview_schema(data)
        schema_columns <- c(
            list(integer(), integer()),
            lapply(seq_len(ncol(schema)), function(position) {
                dataview_column(schema, position)
            })
        )
        previous <- cache[[key]]
        generation <- if (is.null(previous)) 1L else previous$generation + 1L

        state <- list(
            data = data,
            column_count = length(column_names),
            columns = .mapply(
                get_column_def,
                list(full_names, fields, schema_columns),
                NULL
            ),
            fields = fields,
            total_unfiltered = nrow(data),
            generation = generation,
            query_key = NULL,
            query_indices = NULL
        )
        cache[[key]] <- state
        state
    }

    function(data = NULL, start = 0, end = NULL,
             sortModel = NULL, filterModel = NULL,
             metadata_only = FALSE, force = FALSE,
             key = "<default>", generation = NULL,
             dispose = FALSE) {

        state <- cache[[key]]
        if (dispose) {
            if (!is.null(generation) &&
                    !is.null(state) &&
                    !identical(as.integer(generation), state$generation)) {
                return(invisible(FALSE))
            }
            cache[[key]] <- NULL
            return(invisible(TRUE))
        }
        if (force || is.null(state)) {
            state <- register(data, key)
        }

        if (!is.null(generation) && !identical(as.integer(generation), state$generation)) {
            stop("stale data viewer request")
        }

        if (metadata_only) {
            return(list(
                columns = state$columns,
                generation = state$generation
            ))
        }

        query_key <- dataview_query_key(sortModel, filterModel)
        if (!identical(query_key, state$query_key)) {
            state$query_key <- query_key
            state$query_indices <- dataview_query_indices(state, sortModel, filterModel)
            cache[[key]] <- state
        }

        total_rows <- if (is.null(state$query_indices)) {
            state$total_unfiltered
        } else {
            length(state$query_indices)
        }
        if (is.null(end)) {
            end <- total_rows
        }
        first <- max(1L, as.integer(start) + 1L)
        last <- min(total_rows, as.integer(end))

        if (first > total_rows || last < 1L || first > last) {
            source_rows <- integer()
            display_rows <- integer()
        } else {
            display_rows <- seq.int(first, last)
            source_rows <- if (is.null(state$query_indices)) {
                display_rows
            } else {
                state$query_indices[display_rows]
            }
        }

        page <- dataview_format_page(dataview_slice(state$data, source_rows))
        rows <- cbind(
            data.frame(display_rows, source_rows, check.names = FALSE),
            page
        )
        names(rows) <- state$fields

        list(
            rows = rows,
            totalRows = total_rows,
            totalUnfiltered = state$total_unfiltered,
            generation = state$generation
        )
    }
})

if (use_webserver) {
    if (requireNamespace("httpuv", quietly = TRUE)) {
        request_handlers <- list(
            hover = function(expr, ...) {
                tryCatch({
                    expr <- parse(text = expr, keep.source = FALSE)[[1]]
                    obj <- eval(expr, .GlobalEnv)
                    list(str = capture_str(obj))
                }, error = function(e) NULL)
            },

            complete = function(expr, trigger, ...) {
                obj <- tryCatch({
                    expr <- parse(text = expr, keep.source = FALSE)[[1]]
                    eval(expr, .GlobalEnv)
                }, error = function(e) NULL)

                if (is.null(obj)) {
                    return(NULL)
                }

                if (trigger == "$") {
                    names <- if (is.object(obj)) {
                        .DollarNames(obj, pattern = "")
                    } else if (is.recursive(obj)) {
                        names(obj)
                    } else {
                        NULL
                    }

                    result <- lapply(names, function(name) {
                        err_msg <- NULL
                        item <- tryCatch(obj[[name]], error = function(e) {
                            err_msg <<- conditionMessage(e)
                            NULL
                        })
                        if (!is.null(err_msg)) {
                            return(NULL)
                        }
                        list(
                            name = name,
                            type = typeof(item),
                            str = try_capture_str(item)
                        )
                    })
                    result <- Filter(Negate(is.null), result)
                    return(result)
                }

                if (trigger == "@" && isS4(obj)) {
                    names <- slotNames(obj)
                    result <- lapply(names, function(name) {
                        item <- slot(obj, name)
                        list(
                            name = name,
                            type = typeof(item),
                            str = try_capture_str(item)
                        )
                    })
                    return(result)
                }
            },
            dataview_fetch_rows = function(varname, start, end, sortModel, filterModel,
                                           generation = NULL, view_id = NULL, ...) {
                dataview_table(
                    start = start,
                    end = end,
                    sortModel = sortModel,
                    filterModel = filterModel,
                    key = if (is.null(view_id)) varname else view_id,
                    generation = generation
                )
            },
            dataview_dispose = function(view_id, generation = NULL, ...) {
                disposed <- dataview_table(key = view_id, generation = generation, dispose = TRUE)
                if (isTRUE(disposed) &&
                        exists("dataview_sources", inherits = FALSE) &&
                        exists(view_id, envir = dataview_sources, inherits = FALSE)) {
                    rm(list = view_id, envir = dataview_sources)
                }
                invisible(disposed)
            },
            dataview_refresh = function(varname, view_id = NULL, ...) {
                if (exists(".vsc_env_view_cache", envir = .GlobalEnv, inherits = FALSE)) {
                    cache_env <- get(".vsc_env_view_cache", envir = .GlobalEnv)
                    cache_env[[varname]] <- NULL
                }

                source <- if (!is.null(view_id) &&
                                  exists(view_id, envir = dataview_sources, inherits = FALSE)) {
                    get(view_id, envir = dataview_sources, inherits = FALSE)
                } else {
                    list(
                        expression = parse(text = varname)[[1L]],
                        environment = .GlobalEnv
                    )
                }
                obj <- eval(source$expression, envir = source$environment)

                if (is.environment(obj)) {
                    all_names <- ls(obj)
                    is_active <- vapply(all_names, bindingIsActive, logical(1), USE.NAMES = TRUE, obj)
                    is_promise <- rlang::env_binding_are_lazy(obj, all_names[!is_active])
                    obj <- lapply(all_names, function(name) {
                        if (isTRUE(is_promise[name])) {
                            data.frame(
                                name = name,
                                class = "promise",
                                type = "promise",
                                length = 0L,
                                size = 0L,
                                value = "(promise)",
                                stringsAsFactors = FALSE,
                                check.names = FALSE
                            )
                        } else if (isTRUE(is_active[name])) {
                            data.frame(
                                name = name,
                                class = "active_binding",
                                type = "active_binding",
                                length = 0L,
                                size = 0L,
                                value = "(active-binding)",
                                stringsAsFactors = FALSE,
                                check.names = FALSE
                            )
                        } else {
                            obj_item <- obj[[name]]
                            data.frame(
                                name = name,
                                class = paste0(class(obj_item), collapse = ", "),
                                type = typeof(obj_item),
                                length = length(obj_item),
                                size = as.integer(object.size(obj_item)),
                                value = trimws(try_capture_str(obj_item, 0)),
                                stringsAsFactors = FALSE,
                                check.names = FALSE
                            )
                        }
                    })
                    names(obj) <- all_names
                    if (length(obj)) {
                        obj <- do.call(rbind, obj)
                    } else {
                        obj <- data.frame(
                            name = character(),
                            class = character(),
                            type = character(),
                            length = integer(),
                            size = integer(),
                            value = character(),
                            stringsAsFactors = FALSE,
                            check.names = FALSE
                        )
                    }
                    if (!exists(".vsc_env_view_cache", envir = .GlobalEnv, inherits = FALSE)) {
                        assign(".vsc_env_view_cache", new.env(parent = emptyenv()), envir = .GlobalEnv)
                    }
                    cache_env <- get(".vsc_env_view_cache", envir = .GlobalEnv)
                    cache_env[[varname]] <- obj
                }

                if (!dataview_is_table(obj)) {
                    stop("dataview_refresh expects a table object.")
                }

                meta <- dataview_table(
                    obj,
                    metadata_only = TRUE,
                    force = TRUE,
                    key = if (is.null(view_id)) varname else view_id
                )
                file <- tempfile(tmpdir = tempdir, fileext = ".json")
                jsonlite::write_json(meta, file, na = "string", null = "null", auto_unbox = TRUE, force = TRUE)
                list(file = file, generation = meta$generation)
            },

            workspace = function(...) {
                workspace_data()
            },

            workspace_children = function(name, path = list(), start = 1L, ...) {
                workspace_child_page(name, path, start)
            }
        )

        server <- getOption("vsc.server")
        if (!is.null(server) && server$isRunning()) {
            host <- server$getHost()
            port <- server$getPort()
            token <- attr(server, "token")
        } else {
            host <- "127.0.0.1"
            port <- httpuv::randomPort()
            token <- sprintf("%d:%d:%.6f", pid, port, Sys.time())
            server <- httpuv::startServer(host, port,
                list(
                    onHeaders = function(req) {
                        logger("http request ",
                            req[["REMOTE_ADDR"]], ":",
                            req[["REMOTE_PORT"]], " ",
                            req[["REQUEST_METHOD"]], " ",
                            req[["HTTP_USER_AGENT"]]
                        )

                        if (!nzchar(req[["REMOTE_ADDR"]]) || identical(req[["REMOTE_PORT"]], "0")) {
                            return(NULL)
                        }

                        if (!identical(req[["HTTP_AUTHORIZATION"]], token)) {
                            return(list(
                                status = 401L,
                                headers = list(
                                    "Content-Type" = "text/plain"
                                ),
                                body = "Unauthorized"
                            ))
                        }

                        if (!identical(req[["HTTP_CONTENT_TYPE"]], "application/json")) {
                            return(list(
                                status = 400L,
                                headers = list(
                                    "Content-Type" = "text/plain"
                                ),
                                body = "Bad request"
                            ))
                        }
                    },
                    call = function(req) {
                        content <- req$rook.input$read_lines()
                        request <- jsonlite::fromJSON(content, simplifyVector = FALSE)
                        handler <- request_handlers[[request$type]]
                        response <- if (is.function(handler)) do.call(handler, request)

                        list(
                            status = 200L,
                            headers = list(
                                "Content-Type" = "application/json"
                            ),
                            body = jsonlite::toJSON(
                                response,
                                auto_unbox = TRUE,
                                force = TRUE,
                                na = if (identical(request$type, "dataview_fetch_rows")) {
                                    "string"
                                } else {
                                    "null"
                                }
                            )
                        )
                    }
                )
            )
            attr(server, "token") <- token
            options(vsc.server = server)
        }
    } else {
        message("{httpuv} is required to use the session request server.")
        use_webserver <- FALSE
    }
}

get_timestamp <- function() {
    sprintf("%.6f", Sys.time())
}

scalar <- function(x) {
    class(x) <- c("scalar", class(x))
    x
}

request <- function(command, ...) {
    obj <- list(
        time = Sys.time(),
        pid = pid,
        wd = wd,
        command = command,
        ...
    )
    jsonlite::write_json(obj, request_file,
        auto_unbox = TRUE, null = "null", force = TRUE
    )
    cat(get_timestamp(), file = request_lock_file)
}

capture_str <- function(object, max.level = getOption("vsc.str.max.level", 0)) {
    paste0(utils::capture.output(
        utils::str(object,
            max.level = max.level,
            give.attr = FALSE,
            vec.len = 1
        )
    ), collapse = "\n")
}

try_capture_str <- function(object, max.level = getOption("vsc.str.max.level", 0)) {
    tryCatch(
        capture_str(object, max.level = max.level),
        error = function(e) {
            paste0(class(object), collapse = ", ")
        }
    )
}

rebind <- function(sym, value, ns) {
    if (is.character(ns)) {
        Recall(sym, value, getNamespace(ns))
        pkg <- paste0("package:", ns)
        if (pkg %in% search()) {
            Recall(sym, value, as.environment(pkg))
        }
    } else if (is.environment(ns)) {
        if (bindingIsLocked(sym, ns)) {
            unlockBinding(sym, ns)
            on.exit(lockBinding(sym, ns))
        }
        assign(sym, value, ns)
    } else {
        stop("ns must be a string or environment")
    }
}

address <- function(x) {
    info <- utils::capture.output(.Internal(inspect(x, 0L, 0L)))
    sub("@([a-z0-9]+)\\s+.+", "\\1", info[[1]])
}

globalenv_cache <- new.env(parent = emptyenv())

workspace_child_count <- function(obj) {
    if (is.environment(obj)) {
        length(obj)
    } else if (isS4(obj)) {
        length(slotNames(obj))
    } else if (typeof(obj) %in% c("list", "pairlist")) {
        length(obj)
    } else {
        0L
    }
}

inspect_env <- function(env, cache) {
    all_names <- ls(env, sorted = FALSE)
    stale_names <- setdiff(names(cache), all_names)
    if (length(stale_names)) {
        rm(list = stale_names, envir = cache)
    }
    is_active <- vapply(all_names, bindingIsActive, logical(1), USE.NAMES = FALSE, env)
    is_promise <- rep(FALSE, length(all_names))
    if (any(!is_active)) {
        is_promise[!is_active] <- rlang::env_binding_are_lazy(env, all_names[!is_active])
    }
    show_object_size <- getOption("vsc.show_object_size", FALSE)
    objs <- lapply(seq_along(all_names), function(i) {
        name <- all_names[[i]]
        if (isTRUE(is_promise[[i]])) {
            info <- list(
                class = "promise",
                type = scalar("promise"),
                length = scalar(0L),
                str = scalar("(promise)")
            )
        } else if (isTRUE(is_active[[i]])) {
            info <- list(
                class = "active_binding",
                type = scalar("active_binding"),
                length = scalar(0L),
                str = scalar("(active-binding)")
            )
        } else {
            obj <- env[[name]]
            obj_class <- class(obj)
            obj_type <- typeof(obj)
            obj_length <- length(obj)
            obj_dim <- dim(obj)
            first_class <- if (length(obj_class)) obj_class[[1]] else obj_type

            info <- list(
                class = obj_class,
                type = scalar(obj_type),
                length = scalar(obj_length)
            )

            if (show_object_size) {
                addr <- address(obj)
                cobj <- cache[[name]]
                if (is.null(cobj) || cobj$address != addr || cobj$length != info$length) {
                    cache[[name]] <- cobj <- list(
                        address = addr,
                        length = length(obj),
                        size = unclass(object.size(obj))
                    )
                }
                info$size <- scalar(cobj$size)
            }

            if (!is.null(obj_dim)) {
                info$str <- scalar(paste0(first_class, ": ", paste(obj_dim, collapse = " x ")))
            } else if (obj_type == "environment") {
                info$str <- scalar("<environment>")
            } else if (obj_type == "closure" || obj_type == "builtin") {
                info$str <- scalar(trimws(try_capture_str(obj, 0)))
            } else {
                info$str <- scalar(paste0(first_class, ", length ", obj_length))
            }

            info$has_children <- scalar(workspace_child_count(obj) > 0L)

            obj_names <- if (is.object(obj)) {
                .DollarNames(obj, pattern = "")
            } else if (is.recursive(obj)) {
                names(obj)
            } else {
                NULL
            }

            if (length(obj_names)) {
                info$names <- obj_names
            }

            if (isS4(obj)) {
                info$slots <- slotNames(obj)
            }

            if (!is.null(obj_dim)) {
                info$dim <- obj_dim
            }
        }
        info
    })
    names(objs) <- all_names
    objs
}

dir_session <- file.path(tempdir, "vscode-R")
dir.create(dir_session, showWarnings = FALSE, recursive = TRUE)

removeTaskCallback("vsc.workspace")
show_globalenv <- isTRUE(getOption("vsc.globalenv", TRUE))
workspace_lock_file <- file.path(dir_session, "workspace.lock")
file.create(workspace_lock_file, showWarnings = FALSE)

workspace_data <- function() {
    list(
        search = search()[-1],
        loaded_namespaces = loadedNamespaces(),
        globalenv = if (show_globalenv) inspect_env(.GlobalEnv, globalenv_cache) else NULL
    )
}

workspace_object <- function(name, path = list()) {
    object <- get(name, envir = .GlobalEnv, inherits = FALSE)
    for (selector in path) {
        object <- switch(selector$kind,
            index = object[[as.integer(selector$value)]],
            name = get(selector$value, envir = object, inherits = FALSE),
            slot = slot(object, selector$value),
            stop("Unknown workspace selector")
        )
    }
    object
}

workspace_child_page_size <- 500L

workspace_child_item <- function(object, str, selector) {
    list(
        str = scalar(str),
        class = scalar(paste(class(object), collapse = ", ")),
        type = scalar(typeof(object)),
        has_children = scalar(workspace_child_count(object) > 0L),
        selector = selector
    )
}

workspace_child_label <- function(name, index) {
    if (!is.null(name) && !is.na(name) && nzchar(name)) {
        paste0("$ ", name)
    } else {
        paste0("[[", index, "]]")
    }
}

workspace_child_page <- function(name, path = list(), start = 1L) {
    tryCatch({
        object <- workspace_object(name, path)
        child_count <- workspace_child_count(object)
        if (child_count == 0L) {
            return(list(children = I(list()), next_start = NULL))
        }

        start <- max(1L, as.integer(start))
        end <- min(child_count, start + workspace_child_page_size - 1L)
        if (start > end) {
            return(list(children = I(list()), next_start = NULL))
        }

        children <- if (is.environment(object)) {
            child_names <- ls(object, sorted = FALSE)[seq.int(start, end)]
            lapply(child_names, function(child_name) {
                if (bindingIsActive(child_name, object)) {
                    list(
                        str = scalar(paste0("$ ", child_name, ": (active-binding)")),
                        class = scalar("active_binding"),
                        type = scalar("active_binding"),
                        has_children = scalar(FALSE)
                    )
                } else {
                    child <- get(child_name, envir = object, inherits = FALSE)
                    workspace_child_item(
                        child,
                        paste0("$ ", child_name, ": ", trimws(try_capture_str(child, 0))),
                        list(kind = "name", value = child_name)
                    )
                }
            })
        } else if (isS4(object)) {
            child_names <- slotNames(object)[seq.int(start, end)]
            lapply(child_names, function(child_name) {
                child <- slot(object, child_name)
                workspace_child_item(
                    child,
                    paste0("@ ", child_name, ": ", trimws(try_capture_str(child, 0))),
                    list(kind = "slot", value = child_name)
                )
            })
        } else if (typeof(object) %in% c("list", "pairlist")) {
            indices <- seq.int(start, end)
            child_names <- names(object)
            lapply(indices, function(index) {
                child <- object[[index]]
                child_name <- if (is.null(child_names)) NULL else child_names[[index]]
                workspace_child_item(
                    child,
                    paste0(
                        workspace_child_label(child_name, index),
                        ": ",
                        trimws(try_capture_str(child, 0))
                    ),
                    list(kind = "index", value = scalar(index))
                )
            })
        } else {
            list()
        }

        list(
            children = I(children),
            next_start = if (end < child_count) scalar(end + 1L) else NULL
        )
    }, error = function(e) list(children = I(list()), next_start = NULL))
}

update_workspace <- function(...) {
    cat(get_timestamp(), file = workspace_lock_file)
    TRUE
}
update_workspace()
addTaskCallback(update_workspace, name = "vsc.workspace")

removeTaskCallback("vsc.plot")
use_httpgd <- identical(getOption("vsc.use_httpgd", FALSE), TRUE)
show_plot <- !identical(getOption("vsc.plot", "Two"), FALSE)
if (use_httpgd && "httpgd" %in% .packages(all.available = TRUE)) {
    httpgd_plot_updated <- FALSE

    is_httpgd_dev <- function() {
        names(dev.cur()) %in% c("httpgd", "unigd")
    }

    request_httpgd <- function() {
        tryCatch({
            if (length(httpgd::hgd_details()) > 0) {
                .vsc$request("httpgd", url = httpgd::hgd_url())
            }
        }, error = message)
    }

    new_httpgd_plot <- function(...) {
        if (is_httpgd_dev()) {
            httpgd_plot_updated <<- TRUE
        }
    }

    options(device = function(...) {
        httpgd::hgd(
            silent = TRUE
        )
        request_httpgd()
    })

    update_httpgd_plot <- function(...) {
        tryCatch({
            if (httpgd_plot_updated && is_httpgd_dev()) {
                httpgd_plot_updated <<- FALSE
                request_httpgd()
            }
        }, error = message)
        TRUE
    }

    setHook("plot.new", new_httpgd_plot, "replace")
    setHook("grid.newpage", new_httpgd_plot, "replace")

    rebind(".External.graphics", function(...) {
        out <- .Primitive(".External.graphics")(...)
        if (is_httpgd_dev()) {
            httpgd_plot_updated <<- TRUE
        }
        out
    }, "base")

    addTaskCallback(update_httpgd_plot, name = "vsc.plot")
} else if (use_httpgd) {
    message("Install package `httpgd` to use vscode-R with httpgd!")
} else if (show_plot) {
    plot_file <- file.path(dir_session, "plot.png")
    plot_lock_file <- file.path(dir_session, "plot.lock")
    file.create(plot_file, plot_lock_file, showWarnings = FALSE)

    plot_updated <- FALSE
    null_dev_id <- c(pdf = 2L)
    null_dev_size <- c(7 + pi, 7 + pi)

    check_null_dev <- function() {
        identical(dev.cur(), null_dev_id) &&
            identical(dev.size(), null_dev_size)
    }

    new_plot <- function() {
        if (check_null_dev()) {
            plot_updated <<- TRUE
        }
    }

    options(
        device = function(...) {
            pdf(NULL,
                width = null_dev_size[[1L]],
                height = null_dev_size[[2L]],
                bg = "white")
            dev.control(displaylist = "enable")
        }
    )

    update_plot <- function(...) {
        tryCatch({
            if (plot_updated && check_null_dev()) {
                plot_updated <<- FALSE
                record <- recordPlot()
                if (length(record[[1L]])) {
                    dev_args <- getOption("vsc.dev.args")
                    do.call(png, c(list(filename = plot_file), dev_args))
                    on.exit({
                        dev.off()
                        cat(get_timestamp(), file = plot_lock_file)
                    })
                    replayPlot(record)
                }
            }
        }, error = message)
        TRUE
    }

    setHook("plot.new", new_plot, "replace")
    setHook("grid.newpage", new_plot, "replace")

    rebind(".External.graphics", function(...) {
        out <- .Primitive(".External.graphics")(...)
        if (check_null_dev()) {
            plot_updated <<- TRUE
        }
        out
    }, "base")

    update_plot()
    addTaskCallback(update_plot, name = "vsc.plot")
}

show_view <- !identical(getOption("vsc.view", "Two"), FALSE)
if (show_view) {
    dataview_registry <- new.env(parent = emptyenv())
    dataview_sources <- new.env(parent = emptyenv())

    show_dataview <- function(x, title, uuid = NULL,
                              viewer = getOption("vsc.view", "Two")) {

        source_expression <- substitute(x)
        source_environment <- parent.frame()
        if (missing(title)) {
            title <- deparse1(source_expression, nlines = 1)
        }

        # Generate a unique ID for this dataview based on the title
        title_key <- title
        if (exists(title_key, envir = dataview_registry, inherits = FALSE)) {
            dataview_uuid <- get(title_key, envir = dataview_registry, inherits = FALSE)
            logger("Reusing existing dataview UUID for title:", title, "UUID:", dataview_uuid)
        } else {
            dataview_uuid <- paste0("dataview-", format(Sys.time(), "%Y%m%d%H%M%S"), "-", sample(1000:9999, 1))
            assign(title_key, dataview_uuid, envir = dataview_registry)
            logger("Created new dataview UUID for title:", title, "UUID:", dataview_uuid)
        }

        if (is.environment(x)) {
            all_names <- ls(x)
            is_active <- vapply(all_names, bindingIsActive, logical(1), USE.NAMES = TRUE, x)
            is_promise <- rlang::env_binding_are_lazy(x, all_names[!is_active])
            x <- lapply(all_names, function(name) {
                if (isTRUE(is_promise[name])) {
                    data.frame(
                        name = name,
                        class = "promise",
                        type = "promise",
                        length = 0L,
                        size = 0L,
                        value = "(promise)",
                        stringsAsFactors = FALSE,
                        check.names = FALSE
                    )
                } else if (isTRUE(is_active[name])) {
                    data.frame(
                        name = name,
                        class = "active_binding",
                        type = "active_binding",
                        length = 0L,
                        size = 0L,
                        value = "(active-binding)",
                        stringsAsFactors = FALSE,
                        check.names = FALSE
                    )
                } else {
                    obj <- x[[name]]
                    data.frame(
                        name = name,
                        class = paste0(class(obj), collapse = ", "),
                        type = typeof(obj),
                        length = length(obj),
                        size = as.integer(object.size(obj)),
                        value = trimws(try_capture_str(obj, 0)),
                        stringsAsFactors = FALSE,
                        check.names = FALSE
                    )
                }
            })
            names(x) <- all_names
            if (length(x)) {
                x <- do.call(rbind, x)
            } else {
                x <- data.frame(
                    name = character(),
                    class = character(),
                    type = character(),
                    length = integer(),
                    size = integer(),
                    value = character(),
                    stringsAsFactors = FALSE,
                    check.names = FALSE
                )
            }
            if (!exists(".vsc_env_view_cache", envir = .GlobalEnv, inherits = FALSE)) {
                assign(".vsc_env_view_cache", new.env(parent = emptyenv()), envir = .GlobalEnv)
            }
            cache_env <- get(".vsc_env_view_cache", envir = .GlobalEnv)
            cache_env[[title]] <- x
        }
        if (dataview_is_table(x)) {
            assign(
                dataview_uuid,
                list(expression = source_expression, environment = source_environment),
                envir = dataview_sources
            )
            meta <- dataview_table(
                x,
                metadata_only = TRUE,
                force = TRUE,
                key = dataview_uuid
            )
            file <- tempfile(tmpdir = tempdir, fileext = ".json")
            jsonlite::write_json(meta, file, na = "string", null = "null", auto_unbox = TRUE, force = TRUE)
            request("dataview", source = "table", type = "json",
                title = title, file = file, viewer = viewer, uuid = uuid,
                dataview_uuid = dataview_uuid, dataview_generation = meta$generation
            )
        } else if (is.list(x)) {
            tryCatch({
                file <- tempfile(tmpdir = tempdir, fileext = ".json")
                jsonlite::write_json(x, file, na = "string", null = "null", auto_unbox = TRUE, force = TRUE)
                request("dataview", source = "list", type = "json",
                    title = title, file = file, viewer = viewer, uuid = uuid, dataview_uuid = dataview_uuid
                )
            }, error = function(e) {
                file <- file.path(tempdir, paste0(make.names(title), ".txt"))
                text <- utils::capture.output(print(x))
                writeLines(text, file)
                request("dataview", source = "object", type = "txt",
                    title = title, file = file, viewer = viewer, uuid = uuid, dataview_uuid = dataview_uuid
                )
            })
        } else {
            file <- file.path(tempdir, paste0(make.names(title), ".R"))
            if (is.primitive(x)) {
                code <- utils::capture.output(print(x))
            } else {
                code <- deparse(x)
            }
            writeLines(code, file)
            request("dataview", source = "object", type = "R",
                title = title, file = file, viewer = viewer, uuid = uuid, dataview_uuid = dataview_uuid
            )
        }
    }

    rebind("View", show_dataview, "utils")
}

attach <- function() {
    load_settings()
    if (rstudioapi_enabled()) {
        rstudioapi_util_env$update_addin_registry(addin_registry)
    }
    plot_url <- NULL
    if (use_httpgd && requireNamespace("httpgd", quietly = TRUE)) {
        tryCatch(
            {
                if (length(httpgd::hgd_details()) > 0) {
                    plot_url <- httpgd::hgd_url()
                }
            },
            error = function(e) {
                plot_url <<- NULL
            }
        )
    }
    request("attach",
        version = sprintf("%s.%s", R.version$major, R.version$minor),
        tempdir = tempdir,
        info = list(
            command = commandArgs()[[1L]],
            version = R.version.string,
            start_time = format(file.info(tempdir)$ctime)
        ),
        plot_url = plot_url,
        server = if (use_webserver) {
            list(
                host = host,
                port = port,
                token = token
            )
        } else {
            NULL
        }
    )
}

path_to_uri <- function(path) {
    if (length(path) == 0) {
        return(character())
    }
    path <- path.expand(path)
    if (.Platform$OS.type == "windows") {
        prefix <- "file:///"
        path <- gsub("\\", "/", path, fixed = TRUE)
    } else {
        prefix <- "file://"
    }
    paste0(prefix, utils::URLencode(path))
}

request_browser <- function(url, title, ..., viewer) {
    message("Browsing ", url)
    request("browser", url = url, title = title, ..., viewer = viewer)
}

show_browser <- function(url, title = url, ...,
                         viewer = getOption("vsc.browser", "Active")) {
    proxy_uri <- Sys.getenv("VSCODE_PROXY_URI")
    if (nzchar(proxy_uri)) {
        is_base_path <- grepl("\\:\\d+$", url)
        url <- sub("^https?\\://(127\\.0\\.0\\.1|localhost)(\\:)?",
            sub("\\{\\{?port\\}\\}?/?", "", proxy_uri), url
        )
        if (is_base_path) {
            url <- paste0(url, "/")
        }
    }
    if (grepl("^https?\\://(127\\.0\\.0\\.1|localhost)(\\:\\d+)?", url)) {
        request_browser(url = url, title = title, ..., viewer = viewer)
    } else if (grepl("^https?\\://", url)) {
        message(
            if (nzchar(proxy_uri)) {
                "VSCode is not running on localhost but on a remote server.\n"
            } else {
                "VSCode WebView only supports showing local http content.\n"
            },
            "Opening in external browser..."
        )
        request_browser(url = url, title = title, ..., viewer = FALSE)
    } else {
        path <- sub("^file\\://", "", url)
        if (file.exists(path)) {
            path <- normalizePath(path, "/", mustWork = TRUE)
            if (grepl("\\.html?$", path, ignore.case = TRUE)) {
                message(
                    "VSCode WebView has restricted access to local file.\n",
                    "Opening in external browser..."
                )
                request_browser(url = path_to_uri(path),
                    title = title, ..., viewer = FALSE
                )
            } else {
                request("dataview", source = "object", type = "txt",
                    title = title, file = path, viewer = viewer
                )
            }
        } else {
            stop("File not exists")
        }
    }
}

show_webview <- function(url, title, ..., viewer) {
    if (!is.character(url)) {
        real_url <- NULL
        temp_viewer <- function(url, ...) {
            real_url <<- url
        }
        op <- options(viewer = temp_viewer, page_viewer = temp_viewer)
        on.exit(options(op))
        print(url)
        if (is.character(real_url)) {
            url <- real_url
        } else {
            stop("Invalid object")
        }
    }
    proxy_uri <- Sys.getenv("VSCODE_PROXY_URI")
    if (nzchar(proxy_uri)) {
        is_base_path <- grepl("\\:\\d+$", url)
        url <- sub("^https?\\://(127\\.0\\.0\\.1|localhost)(\\:)?",
            sub("\\{\\{?port\\}\\}?/?", "", proxy_uri), url
        )
        if (is_base_path) {
            url <- paste0(url, "/")
        }
    }
    if (grepl("^https?\\://(127\\.0\\.0\\.1|localhost)(\\:\\d+)?", url)) {
        request_browser(url = url, title = title, ..., viewer = viewer)
    } else if (grepl("^https?\\://", url)) {
        message(
            if (nzchar(proxy_uri)) {
                "VSCode is not running on localhost but on a remote server.\n"
            } else {
                "VSCode WebView only supports showing local http content.\n"
            },
            "Opening in external browser..."
        )
        request_browser(url = url, title = title, ..., viewer = FALSE)
    } else if (file.exists(url)) {
        file <- normalizePath(url, "/", mustWork = TRUE)
        request("webview", file = file, title = title, viewer = viewer, ...)
    } else {
        stop("File not exists")
    }
}

show_viewer <- function(url, title = NULL, ...,
                        viewer = getOption("vsc.viewer", "Two")) {
    if (is.null(title)) {
        expr <- substitute(url)
        if (is.character(url)) {
            title <- "Viewer"
        } else {
            title <- deparse(expr, nlines = 1)
        }
    }
    show_webview(url = url, title = title, ..., viewer = viewer)
}

show_page_viewer <- function(url, title = NULL, ...,
                             viewer = getOption("vsc.page_viewer", "Active")) {
    if (is.null(title)) {
        expr <- substitute(url)
        if (is.character(url)) {
            title <- "Page Viewer"
        } else {
            title <- deparse(expr, nlines = 1)
        }
    }
    show_webview(url = url, title = title, ..., viewer = viewer)
}

options(
    browser = show_browser,
    viewer = show_viewer,
    page_viewer = show_page_viewer
)

rstudioapi_enabled <- function() {
    isTRUE(getOption("vsc.rstudioapi", TRUE))
}

if (rstudioapi_enabled()) {
    response_timeout <- 5
    response_lock_file <- file.path(dir_session, "response.lock")
    response_file <- file.path(dir_session, "response.log")
    file.create(response_lock_file, showWarnings = FALSE)
    file.create(response_file, showWarnings = FALSE)
    addin_registry <- file.path(dir_session, "addins.json")

    get_response_timestamp <- function() {
        readLines(response_lock_file)
    }

    response_time_stamp <- ""

    get_response_lock <- function() {
        lock_time_stamp <- get_response_timestamp()
        if (isTRUE(lock_time_stamp != response_time_stamp)) {
            response_time_stamp <<- lock_time_stamp
            TRUE
        } else {
            FALSE
        }
    }

    request_response <- function(command, ...) {
        request(command, ..., sd = dir_session)
        wait_start <- Sys.time()
        while (!get_response_lock()) {
            if ((Sys.time() - wait_start) > response_timeout) {
                stop(
                    "Did not receive a response from VSCode-R API within ",
                    response_timeout, " seconds."
                )
            }
            Sys.sleep(0.1)
        }
        jsonlite::read_json(response_file)
    }

    rstudioapi_util_env <- new.env()
    rstudioapi_env <- new.env(parent = rstudioapi_util_env)
    source(file.path(dir_init, "rstudioapi_util.R"), local = rstudioapi_util_env)
    source(file.path(dir_init, "rstudioapi.R"), local = rstudioapi_env)
    setHook(
        packageEvent("rstudioapi", "onLoad"),
        function(...) {
            rstudioapi_util_env$rstudioapi_patch_hook(rstudioapi_env)
        }
    )
    if ("rstudioapi" %in% loadedNamespaces()) {
        rstudioapi_util_env$rstudioapi_patch_hook(rstudioapi_env)
    }

}

print.help_files_with_topic <- function(h, ...) {
    viewer <- getOption("vsc.helpPanel", "Two")
    if (!identical(FALSE, viewer) && length(h) >= 1 && is.character(h)) {
        file <- h[1]
        path <- dirname(file)
        dirpath <- dirname(path)
        pkgname <- basename(dirpath)
        requestPath <- paste0(
            "/library/",
            pkgname,
            "/html/",
            basename(file),
            ".html"
        )
        request(command = "help", requestPath = requestPath, viewer = viewer)
    } else {
        utils:::print.help_files_with_topic(h, ...)
    }
    invisible(h)
}

print.hsearch <- function(x, ...) {
    viewer <- getOption("vsc.helpPanel", "Two")
    if (!identical(FALSE, viewer) && length(x) >= 1) {
        requestPath <- paste0(
            "/doc/html/Search?pattern=",
            tools:::escapeAmpersand(x$pattern),
            paste0("&fields.", x$fields, "=1",
                collapse = ""
            ),
            if (!is.null(x$agrep)) paste0("&agrep=", x$agrep),
            if (!x$ignore.case) "&ignore.case=0",
            if (!identical(
                x$types,
                getOption("help.search.types")
            )) {
                paste0("&types.", x$types, "=1",
                    collapse = ""
                )
            },
            if (!is.null(x$package)) {
                paste0(
                    "&package=",
                    paste(x$package, collapse = ";")
                )
            },
            if (!identical(x$lib.loc, .libPaths())) {
                paste0(
                    "&lib.loc=",
                    paste(x$lib.loc, collapse = ";")
                )
            }
        )
        request(command = "help", requestPath = requestPath, viewer = viewer)
    } else {
        utils:::print.hsearch(x, ...)
    }
    invisible(x)
}

.S3method <- function(generic, class, method) {
    if (missing(method)) {
        method <- paste(generic, class, sep = ".")
    }
    method <- match.fun(method)
    registerS3method(generic, class, method, envir = parent.frame())
    invisible(NULL)
}

reg.finalizer(.GlobalEnv, function(e) .vsc$request("detach"), onexit = TRUE)
