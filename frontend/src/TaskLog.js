import React from 'react';

import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from "@mui/icons-material/Close";
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Grid from '@mui/material/Grid';
import IconButton from "@material-ui/core/IconButton";
import ListItemText from '@mui/material/ListItemText';
import PopoutButton from './PopoutButton';
import ReloadButton from './ReloadButton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';


function Log(props) {
    const log = props.value;

    if (log === "") {
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

    let logLines = log.split("\n");
    logLines = logLines.filter((line) => {
        return props.filters.includes(line.slice(28, 35).trim()) || (line[27] != "[" && props.filters.includes("STDOUT"));
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
            url: "/api/v1/tasks/" + props.task.id + "/log",
        };
    }

    componentWillReceiveProps(newProps) {
        if (!this.state.open && newProps.open) {
            var url = "/api/v1/tasks/" + newProps.task.id + "/log";
            this.setState(function(prevState, props) {
                return {
                    open: newProps.open,
                    task: newProps.task,
                    url: url,
                };
            });
            this.fetchLog(url);
        } else {
            this.setState({ open: newProps.open });
        }
    }

    fetchLog(url) {
        console.log("Fetching log for " + url);

        this.setState(function(prevState, props) {
            return { log: "" };
        });

        fetch(url)
            .then((response) => response.text())
            .then((data) => {
                this.setState(function(prevState, props) { return { log: data }; });
            })
        .catch((reason) => {
            console.log(reason);
        });
    }

    setFilters(filters) {
        this.setState({ filters: filters });
    }

    render() {
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
                            <PopoutButton color="primary" href={this.state.url} />
                        </Box>
                        <Box className="w3-margin-right">
                            <ReloadButton color="primary" onClick={(ev, val) => { this.fetchLog(this.state.url); }} />
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
                <DialogContent dividers={true}>
                    <DialogContentText
                        id="scroll-dialog-description"
                        tabIndex={-1}
                    >
                        <Log value={this.state.log} filters={this.state.filters} />
                    </DialogContentText>
                </DialogContent>
            </Dialog>
        )
    }
}

export default TaskLog;
