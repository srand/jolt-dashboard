import PauseIcon from "@mui/icons-material/Pause";
import PlayIcon from "@mui/icons-material/PlayArrow";
import ToggleButton from '@mui/material/ToggleButton';



const PauseButton = ({ color, selected, onPlay, onPause }) => {
    if (!selected) {
        return (
            <ToggleButton color={color} selected={false} onClick={onPlay}>
                <PlayIcon />
            </ToggleButton>
        );
    }
    return (
        <ToggleButton color={color} selected={true} onClick={onPause}>
            <PauseIcon />
        </ToggleButton>
    );
};


export default PauseButton;
