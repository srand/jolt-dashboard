import React from 'react';

import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from "@mui/icons-material/Close";
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Grid from '@mui/material/Grid';
import IconButton from "@mui/material/IconButton";
import ListItemText from '@mui/material/ListItemText';
import PopoutButton from './PopoutButton';
import ReloadButton from './ReloadButton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

import { createLogDecoder, isTerminalStatus } from './logStream';
import { isScrolledToBottom } from './scroll';

// How long to wait before asking again for a log that does not exist yet. A
// task can be running before its first line is written.
const RETRY_DELAY_MS = 2000;

// Shown when a stream has finished (or failed for good) and there is still
// nothing to display. Overridden with a specific error message when the
// cause was a failure rather than a genuinely empty log.
const DEFAULT_EMPTY_MESSAGE = "No log output.";


function Log(props) {
    const log = props.value;

    if (log === "") {
        if (!props.loaded) {
            return (
                <Box
                    display="flex"
                    justifyContent="center"
                    alignItems="center"
                    minHeight="50vh"
                    minWidth="50vw"
                >
                    <CircularProgress flexGrow={1} />
                </Box>
            );
        }

        return (
            <Box
                display="flex"
                justifyContent="center"
                alignItems="center"
                minHeight="50vh"
                minWidth="50vw"
            >
                {props.message}
            </Box>
        );
    }

    let logLines = log.split("\n");
    logLines = logLines.filter((line) => {
        return props.filters.includes(line.slice(28, 35).trim()) || (line[27] !== "[" && props.filters.includes("STDOUT"));
    });

    return (
        <pre >{logLines.join("\n")}</pre>
    );
}


class TaskLog extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            filters: ["INFO", "ERROR", "STDOUT", "STDERR"],
            open: props.open,
            task: props.task,
            log: "",
            loaded: false,
            message: DEFAULT_EMPTY_MESSAGE,
            url: "/api/v1/tasks/" + props.task.id + "/log",
        };

        this.scrollRef = React.createRef();
        // Start following; the user scrolling up turns it off.
        this.following = true;
        this.controller = null;
        this.retryTimer = null;
    }

    componentWillReceiveProps(newProps) {
        // Either the dialog is opening, or it was already open and is now
        // showing a different task (e.g. the row behind it swapped out from
        // under an open dialog). Both need a fresh stream against the new
        // task's URL.
        const opening = !this.state.open && newProps.open;
        const switchingTask = this.state.open && newProps.open && newProps.task.id !== this.state.task.id;

        if (opening || switchingTask) {
            var url = "/api/v1/tasks/" + newProps.task.id + "/log";
            this.setState({
                open: newProps.open,
                task: newProps.task,
                url: url,
            });
            this.fetchLog(url, newProps.task);
        } else {
            this.setState({ open: newProps.open, task: newProps.task });

            if (this.state.open && !newProps.open) {
                this.stopFetching();
            }
        }
    }

    componentWillUnmount() {
        this.stopFetching();
    }

    componentDidUpdate() {
        this.scrollToBottomIfFollowing();
    }

    stopFetching() {
        if (this.controller) {
            this.controller.abort();
            this.controller = null;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    scrollToBottomIfFollowing() {
        const element = this.scrollRef.current;
        if (element && this.following) {
            element.scrollTop = element.scrollHeight;
        }
    }

    onScroll() {
        // Stop fighting the user once they scroll up; resume when they come back.
        this.following = isScrolledToBottom(this.scrollRef.current);
    }

    fetchLog(url, task) {
        console.log("Fetching log for " + url);

        this.stopFetching();
        this.following = true;
        this.setState({ log: "", loaded: false, message: DEFAULT_EMPTY_MESSAGE });

        const follow = !isTerminalStatus(task.Status);
        this.streamLog(follow ? url + "?follow=1" : url, task);
    }

    // Marks the stream as finished (successfully empty, or failed in a way
    // that will not be retried), so the dialog can stop showing the spinner.
    // Ignores a stream this component has already moved on from.
    finish(controller, message) {
        if (this.controller === controller) {
            this.setState((prevState) => ({
                loaded: true,
                message: message === undefined ? prevState.message : message,
            }));
        }
    }

    streamLog(url, task) {
        const controller = new AbortController();
        this.controller = controller;

        fetch(url, { signal: controller.signal })
            .then((response) => {
                if (response.status === 404) {
                    // The task may not have written anything yet. Keep asking
                    // while it is still running; a terminal task is never
                    // going to write one, so stop and show the empty state.
                    if (!isTerminalStatus(this.state.task.Status)) {
                        this.retryTimer = setTimeout(() => {
                            this.retryTimer = null;
                            if (this.controller === controller) {
                                this.streamLog(url, task);
                            }
                        }, RETRY_DELAY_MS);
                        return;
                    }

                    this.finish(controller);
                    return;
                }

                if (!response.ok) {
                    // An upstream failure (e.g. a 5xx from logstash). Don't
                    // stream the error body through the log view.
                    this.finish(controller, "Error loading log.");
                    return;
                }

                return this.consume(response, controller);
            })
            .catch((reason) => {
                if (reason.name !== "AbortError") {
                    console.log(reason);
                    this.finish(controller, "Error loading log.");
                }
            });
    }

    consume(response, controller) {
        const reader = response.body.getReader();
        const decoder = createLogDecoder();

        const append = (text) => {
            // Ignore a stream this component has already moved on from.
            if (text !== "" && this.controller === controller) {
                this.setState((prevState) => ({ log: prevState.log + text }));
            }
        };

        const pump = () => {
            return reader.read().then(({ done, value }) => {
                if (done) {
                    append(decoder.flush());
                    this.finish(controller);
                    return;
                }

                append(decoder.push(value));
                return pump();
            });
        };

        return pump();
    }

    setFilters(filters) {
        this.setState({ filters: filters });
    }

    render() {
        const following = !isTerminalStatus(this.state.task.Status);
        const popoutUrl = following ? this.state.url + "?follow=1" : this.state.url;

        return (
            <Dialog
                open={this.state.open}
                onClose={() => { this.props.onClose(); }}
                aria-labelledby="scroll-dialog-title"
                aria-describedby="scroll-dialog-description"
                display="flex"
                PaperProps={{ sx: { minWidth: "70vw", maxWidth: "70vw", minHeight: "90vh", maxHeight: "90vh", } }}
            >
                <DialogTitle id="scroll-dialog-title">
                    <Box display="flex" alignItems="center">
                      <ListItemText primaryTypographyProps={{variant: "h5"}} primary={this.state.task.Name} secondary={this.state.task.Identity}></ListItemText>
                        <Box>
                            <IconButton onClick={() => { this.props.onClose(); }}>
                                <CloseIcon />
                            </IconButton>
                        </Box>
                    </Box>
                </DialogTitle>
                <Box display="flex" alignItems="center" marginLeft={3} marginRight={3} marginBottom={1}>
                    <Box flexGrow={1} >
                        <Grid container spacing={2}>
                            <Grid item xs={4}>
                                <ListItemText primary={this.state.task.Started} secondary="Started"></ListItemText>
                            </Grid>
                            <Grid item xs={4}>
                                <ListItemText primary={this.state.task.Ended} secondary="Finished"></ListItemText>
                            </Grid>
                            <Grid item xs={4}>
                                <ListItemText primary={this.state.task.Status} secondary="Outcome"></ListItemText>
                            </Grid>
                        </Grid>
                    </Box>
                    <Box display="flex">
                        <Box className="w3-margin-right">
                            <PopoutButton color="primary" href={popoutUrl} />
                        </Box>
                        <Box className="w3-margin-right">
                            <ReloadButton color="primary" onClick={(ev, val) => { this.fetchLog(this.state.url, this.state.task); }} />
                        </Box>
                        <Box>
                            <ToggleButtonGroup value={this.state.filters} onChange={(ev, val) => { this.setFilters(val); }}>
                                <ToggleButton color="primary" value="EXCEPT" >EXCEPT</ToggleButton>
                                <ToggleButton color="primary" value="DEBUG" >DEBUG</ToggleButton>
                                <ToggleButton color="primary" value="VERBOSE" >VERBOSE</ToggleButton>
                                <ToggleButton color="primary" value="INFO" >INFO</ToggleButton>
                                <ToggleButton color="primary" value="ERROR" >ERROR</ToggleButton>
                                <ToggleButton color="primary" value="STDOUT" >STDOUT</ToggleButton>
                                <ToggleButton color="primary" value="STDERR" >STDERR</ToggleButton>
                            </ToggleButtonGroup>
                        </Box>
                    </Box>
                </Box>
                <DialogContent dividers={true} ref={this.scrollRef} onScroll={() => { this.onScroll(); }}>
                    <DialogContentText
                        id="scroll-dialog-description"
                        tabIndex={-1}
                    >
                        <Log value={this.state.log} filters={this.state.filters} loaded={this.state.loaded} message={this.state.message} />
                    </DialogContentText>
                </DialogContent>
            </Dialog>
        )
    }
}

export default TaskLog;
